import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Stop,
  Line as SvgLine,
} from 'react-native-svg';

/**
 * The speed dial from a factory-fit instrument cluster.
 *
 * Playback and live tracking both used to show speed as a bare number, which
 * reads as telemetry rather than as driving. A swept arc gives the value a
 * scale to sit against, so a glance is enough to tell cruising from crawling
 * without reading the digits at all.
 *
 * Rendered with react-native-svg, which the app already ships, so this costs no
 * new dependency and behaves identically on Android, iOS and web.
 */

/** Bottom-left to bottom-right, clockwise over the top: a 270 degree sweep. */
const START_ANGLE = -135;
const SWEEP = 270;

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

/** Clockwise arc between two angles, in the same degree space as the constants above. */
function arcPath(cx: number, cy: number, radius: number, fromAngle: number, toAngle: number) {
  const start = polarToCartesian(cx, cy, radius, fromAngle);
  const end = polarToCartesian(cx, cy, radius, toAngle);
  const largeArc = Math.abs(toAngle - fromAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export type DriveSpeedGaugeProps = {
  /** Current speed in km/h. Negative and non-finite values read as zero. */
  speedKph: number;
  /** Top of the scale. The arc saturates here rather than overflowing. */
  maxKph?: number;
  /** Outer diameter in points. */
  size?: number;
  accentColor?: string;
  trackColor?: string;
  textColor?: string;
  subTextColor?: string;
  /** Small caption under the readout, e.g. the activity state. */
  caption?: string;
};

export function DriveSpeedGauge({
  speedKph,
  maxKph = 120,
  size = 132,
  accentColor = '#1A73E8',
  trackColor = 'rgba(18,50,71,0.10)',
  textColor = '#0B2B3D',
  subTextColor = '#607783',
  caption,
}: DriveSpeedGaugeProps) {
  const safeSpeed = Number.isFinite(speedKph) ? Math.max(0, speedKph) : 0;
  const ceiling = maxKph > 0 ? maxKph : 120;
  const fraction = Math.min(1, safeSpeed / ceiling);

  const stroke = Math.max(7, size * 0.075);
  const radius = (size - stroke) / 2 - size * 0.045;
  const centre = size / 2;
  const headAngle = START_ANGLE + SWEEP * fraction;

  const trackPath = useMemo(
    () => arcPath(centre, centre, radius, START_ANGLE, START_ANGLE + SWEEP),
    [centre, radius]
  );
  // An arc of zero length has no direction and renders as a stray round cap, so
  // the progress stroke is withheld entirely until the vehicle is actually moving.
  const valuePath = useMemo(
    () => (fraction > 0.002 ? arcPath(centre, centre, radius, START_ANGLE, headAngle) : null),
    [centre, fraction, headAngle, radius]
  );

  /** Six graduations, drawn just inside the arc like a printed dial face. */
  const ticks = useMemo(() => {
    const marks: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    const steps = 6;
    for (let index = 0; index <= steps; index += 1) {
      const angle = START_ANGLE + (SWEEP * index) / steps;
      const major = index % 2 === 0;
      const inner = polarToCartesian(centre, centre, radius - stroke * (major ? 1.0 : 0.82), angle);
      const outer = polarToCartesian(centre, centre, radius - stroke * 0.58, angle);
      marks.push({ x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, major });
    }
    return marks;
  }, [centre, radius, stroke]);

  const head = polarToCartesian(centre, centre, radius, headAngle);
  const rounded = Math.round(safeSpeed);

  return (
    <View style={[styles.wrap, { height: size, width: size }]}>
      <Svg height={size} width={size}>
        <Defs>
          <LinearGradient id="glivtSpeedSweep" x1="0%" y1="100%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor={accentColor} stopOpacity={0.55} />
            <Stop offset="55%" stopColor={accentColor} stopOpacity={1} />
            <Stop offset="100%" stopColor="#8AB4F8" stopOpacity={1} />
          </LinearGradient>
        </Defs>

        <Path
          d={trackPath}
          fill="none"
          stroke={trackColor}
          strokeLinecap="round"
          strokeWidth={stroke}
        />

        {ticks.map((tick, index) => (
          <SvgLine
            key={index}
            opacity={tick.major ? 0.34 : 0.18}
            stroke={textColor}
            strokeLinecap="round"
            strokeWidth={tick.major ? 2 : 1.4}
            x1={tick.x1}
            x2={tick.x2}
            y1={tick.y1}
            y2={tick.y2}
          />
        ))}

        {valuePath ? (
          <Path
            d={valuePath}
            fill="none"
            stroke="url(#glivtSpeedSweep)"
            strokeLinecap="round"
            strokeWidth={stroke}
          />
        ) : null}

        {valuePath ? (
          <>
            <Circle
              cx={head.x}
              cy={head.y}
              fill={accentColor}
              opacity={0.18}
              r={stroke * 0.92}
            />
            <Circle
              cx={head.x}
              cy={head.y}
              fill="#FFFFFF"
              r={stroke * 0.34}
              stroke={accentColor}
              strokeWidth={2.4}
            />
          </>
        ) : null}
      </Svg>

      <View pointerEvents="none" style={styles.readout}>
        <Text style={[styles.value, { color: textColor, fontSize: size * 0.3 }]}>{rounded}</Text>
        <Text style={[styles.unit, { color: subTextColor, fontSize: size * 0.088 }]}>km/h</Text>
        {caption ? (
          <Text
            numberOfLines={1}
            style={[styles.caption, { color: subTextColor, fontSize: size * 0.074 }]}>
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  readout: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { fontVariant: ['tabular-nums'], fontWeight: '900', includeFontPadding: false },
  unit: { fontWeight: '800', letterSpacing: 0.6, marginTop: -2 },
  caption: { fontWeight: '800', letterSpacing: 0.4, marginTop: 2, textTransform: 'uppercase' },
});

export default DriveSpeedGauge;
