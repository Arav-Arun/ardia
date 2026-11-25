import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PATCH = new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url);
const patch = readFileSync(PATCH, "utf8");
const clang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "clang"]).status === 0;

function patchedFile(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  assert.notEqual(start, -1, `the patch no longer changes ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch
    .slice(start, next === -1 ? undefined : next)
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");
}

const textField = patchedFile("Libraries/Text/TextInput/Singleline/RCTUITextField.mm");

function slice(source, from, to, what) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${what} is missing from the patched RCTUITextField.mm`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `${what} lost its end`);
  return source.slice(start, end + to.length);
}

const textDidChange = () => `- (void)_textDidChange\n${slice(textField, "{\n  _textWasPasted = NO;", "\n}\n", "_textDidChange")}`;
const restyle = () => slice(textField, "- (BOOL)ardia_restyleEditorKeepingUndo:", "\n}\n", "ardia_restyleEditorKeepingUndo:");
const plainPasteEditor = () => {
  const start = textField.indexOf("static NSString *RCTUISingleLinePastedText(NSString *text)");
  assert.notEqual(start, -1, "the patch no longer defines RCTUISingleLinePastedText");
  const implementation = textField.indexOf("@implementation RCTUIPlainPasteFieldEditor", start);
  assert.notEqual(implementation, -1, "the patch no longer implements RCTUIPlainPasteFieldEditor");
  return textField.slice(start, implementation) + slice(textField.slice(implementation), "@implementation RCTUIPlainPasteFieldEditor", "\n@end\n", "RCTUIPlainPasteFieldEditor");
};
const fieldEditorForView = () => slice(textField, "- (NSTextView *)fieldEditorForView:(NSView *)controlView", "} // Ardia]", "fieldEditorForView:").replace(/\} \/\/ Ardia\]$/, "}");

test("a single-line field's own change handler restyles its text without emptying the editor's undo", () => {
  const body = textDidChange();
  assert.match(body, /ardia_restyleEditorKeepingUndo:/, "_textDidChange writes the text back through the cell on every keystroke, which empties the field editor's undo (#2284)");
  assert.match(restyle(), /hasMarkedText/, "an input method's marked text must still take the old path");
});

const HARNESS = `
@interface HarnessCell : NSTextFieldCell
@property (nonatomic, copy) NSArray<NSPasteboardType> *pasteTypes;
@end

@implementation HarnessCell {
  RCTUIPlainPasteFieldEditor *_plainPasteEditor;
}
FIELD_EDITOR_FOR_VIEW
@end

@interface RCTUITextField : NSTextField
@property (nonatomic, copy) NSDictionary<NSAttributedStringKey, id> *defaultTextAttributes;
@end

@implementation RCTUITextField {
  BOOL _textWasPasted;
}
+ (Class)cellClass { return HarnessCell.class; }
- (instancetype)initWithFrame:(NSRect)frame
{
  if (self = [super initWithFrame:frame]) {
    self.allowsEditingTextAttributes = YES;
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(_textDidChange) name:NSControlTextDidChangeNotification object:self];
  }
  return self;
}
- (void)setAttributedText:(NSAttributedString *)attributedText { self.attributedStringValue = attributedText; }
- (NSString *)text { return self.stringValue; }
TEXT_DID_CHANGE
RESTYLE
@end

static NSMutableDictionary *out;
static id flag(BOOL value) { return value ? @YES : @NO; }
static NSWindow *window;

static void type(NSTextView *editor, NSString *text)
{
  for (NSUInteger i = 0; i < text.length; i++) {
    [editor insertText:[text substringWithRange:NSMakeRange(i, 1)] replacementRange:NSMakeRange(NSNotFound, 0)];
  }
}

static NSDictionary *run(NSArray<NSPasteboardType> *pasteTypes)
{
  NSMutableDictionary *got = [NSMutableDictionary new];
  RCTUITextField *field = [[RCTUITextField alloc] initWithFrame:NSMakeRect(0, 0, 200, 22)];
  NSDictionary *attributes = @{ NSFontAttributeName : [NSFont systemFontOfSize:13], NSForegroundColorAttributeName : NSColor.systemPinkColor };
  field.defaultTextAttributes = attributes;
  ((HarnessCell *)field.cell).pasteTypes = pasteTypes;
  [window.contentView addSubview:field];
  [window makeFirstResponder:field];
  NSTextView *editor = (NSTextView *)field.currentEditor;
  editor.typingAttributes = @{ NSFontAttributeName : [NSFont systemFontOfSize:20], NSForegroundColorAttributeName : NSColor.systemGreenColor };
  type(editor, @"sidebar");
  got[@"editorClass"] = NSStringFromClass(editor.class);
  got[@"typed"] = [editor.string copy];
  got[@"restyled"] = flag([[editor.textStorage attributesAtIndex:0 effectiveRange:NULL][NSForegroundColorAttributeName] isEqual:NSColor.systemPinkColor]);
  got[@"canUndo"] = flag(editor.undoManager.canUndo);
  if (editor.undoManager.canUndo) [editor.undoManager undo];
  got[@"afterUndo"] = [editor.string copy];
  got[@"canRedo"] = flag(editor.undoManager.canRedo);
  if (editor.undoManager.canRedo) [editor.undoManager redo];
  got[@"afterRedo"] = [editor.string copy];
  [field setAttributedText:[[NSAttributedString alloc] initWithString:@"from js" attributes:attributes]];
  got[@"canUndoAfterOutsideText"] = flag(editor.undoManager.canUndo);
  [window makeFirstResponder:nil];
  [field removeFromSuperview];
  return got;
}

int main(void)
{
  @autoreleasepool {
    [NSApplication sharedApplication];
    out = [NSMutableDictionary new];
    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed = NO;
    out[@"shared"] = run(nil);
    out[@"plainPaste"] = run(@[ NSPasteboardTypeString ]);
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    printf("%s\\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  }
  return 0;
}
`;

test("typing in a single-line field can be undone and redone in AppKit's shared field editor and in the command bar's own", { skip: !clang && "needs clang" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "text-field-undo-"));
  try {
    const source =
      "#import <AppKit/AppKit.h>\n\n" +
      plainPasteEditor() +
      HARNESS.replace("FIELD_EDITOR_FOR_VIEW", fieldEditorForView()).replace("TEXT_DID_CHANGE", textDidChange()).replace("RESTYLE", restyle());
    writeFileSync(join(dir, "main.m"), source);
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-Wno-objc-method-access", "-framework", "AppKit", join(dir, "main.m"), "-o", join(dir, "run")], { stdio: "pipe" });
    const got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 30_000 }).trim());
    assert.notEqual(got.shared.editorClass, "RCTUIPlainPasteFieldEditor");
    assert.equal(got.plainPaste.editorClass, "RCTUIPlainPasteFieldEditor");
    for (const editor of ["shared", "plainPaste"]) {
      const run = got[editor];
      assert.equal(run.typed, "sidebar", editor);
      assert.equal(run.restyled, true, `${editor}: typed text keeps the field's own attributes`);
      assert.equal(run.canUndo, true, `${editor}: Edit › Undo is disabled after typing (#2284)`);
      assert.equal(run.afterUndo, "", editor);
      assert.equal(run.canRedo, true, `${editor}: Redo is disabled after an undo`);
      assert.equal(run.afterRedo, "sidebar", editor);
      assert.equal(run.canUndoAfterOutsideText, false, `${editor}: text set from JS must empty the typing undo, whose ranges no longer fit`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
