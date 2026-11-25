import { useState, type ReactNode } from "react";
import { Text, View, type TextLayoutEvent, type TextStyle, type ViewStyle } from "react-native";
import { typeFace } from "../ui/tokens";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { snappedToGrid } from "../../lib/interfaceScale";
import { currentInterfaceScale } from "../../state/settings/interfaceScale";
import { SYSTEM_FONT } from "./capFit";

type LineMetrics = { ascender: number; capHeight: number };

const lineMetricsByFont = new Map<string, LineMetrics>();

function useLineMetrics(key: string) {
  const [, remeasured] = useState(0);
  const metrics = lineMetricsByFont.get(key);
  const onTextLayout = (e: TextLayoutEvent) => {
    const line = e.nativeEvent.lines[0];
    if (!line || (metrics?.ascender === line.ascender && metrics.capHeight === line.capHeight)) return;
    lineMetricsByFont.set(key, { ascender: line.ascender, capHeight: line.capHeight });
    remeasured((n) => n + 1);
  };
  return { metrics, onTextLayout };
}

const RETINA_PIXELS_PER_POINT = 2;

const retinaPixelsPerPoint = () => RETINA_PIXELS_PER_POINT * currentInterfaceScale();

export function inkCentered(box: number, shiftX: number, inkRise: number, metrics: LineMetrics, inset = 0, pixelsPerPoint = retinaPixelsPerPoint()): ViewStyle {
  const top = box / 2 - Math.round(metrics.ascender) + inkRise;
  const laidTop = Math.floor(top * pixelsPerPoint) / pixelsPerPoint;
  return {
    position: "absolute",
    left: -inset,
    top: laidTop - inset,
    width: box,
    transform: [{ translateX: snappedToGrid(shiftX, pixelsPerPoint) }, { translateY: snappedToGrid(top, pixelsPerPoint) - laidTop }],
  };
}

export function InkHolder({ style, children }: { style: ViewStyle | null; children: ReactNode }) {
  return style ? <View style={style}>{children}</View> : <>{children}</>;
}

export function CapCenteredLetter({
  box,
  fontSize,
  fontWeight,
  color,
  tracking = 0,
  inset = 0,
  lineShiftX = 0,
  pixelsPerPoint,
  children,
}: {
  box: number;
  fontSize: number;
  fontWeight: TextStyle["fontWeight"];
  color: string;
  tracking?: number;
  inset?: number;
  lineShiftX?: number;
  pixelsPerPoint?: number;
  children: string;
}) {
  const face = typeFace();
  const line = useLineMetrics(`${face.fontFamily ?? ""}|${String(fontWeight)}|${fontSize}`);
  const snaps = PLATFORM_FEATURES.snapsTextBaselines;
  const metrics = line.metrics ?? { ascender: fontSize * SYSTEM_FONT.ascender, capHeight: fontSize * SYSTEM_FONT.capHeight };
  return (
    <InkHolder style={snaps ? inkCentered(box, tracking / 2, metrics.capHeight / 2, metrics, inset, pixelsPerPoint) : null}>
      <Text
        numberOfLines={1}
        onTextLayout={snaps ? line.onTextLayout : undefined}
        style={{
          ...face,
          width: box,
          paddingLeft: snaps ? 2 * lineShiftX : 0,
          textAlign: "center",
          fontSize,
          letterSpacing: tracking,
          fontWeight,
          color,
          ...(snaps ? null : { height: box, lineHeight: box, transform: [{ translateX: tracking / 2 }, { translateY: 0 }] }),
        }}
      >
        {children}
      </Text>
    </InkHolder>
  );
}
