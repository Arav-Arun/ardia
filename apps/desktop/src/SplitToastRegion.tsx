import type { ComponentProps } from "react";
import { SplitToast as BrowserSplitToast } from "../../browser/src/components/split/SplitChrome";
import { useToasts } from "../../browser/src/state/app/toasts";
import { PageOverlayRegion } from "./PageOverlayRegion";

export * from "../../browser/src/components/split/SplitChrome";

export function SplitToast(props: ComponentProps<typeof BrowserSplitToast>) {
  const shown = useToasts((s) => !!s.toasts[props.windowId]);
  return (
    <PageOverlayRegion testID="ardia-toast" capturing={shown}>
      <BrowserSplitToast {...props} />
    </PageOverlayRegion>
  );
}
