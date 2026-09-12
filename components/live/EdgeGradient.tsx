import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';

// Full-bleed dark fade at the top/bottom of a live screen, so white UI text/icons stay
// legible over any video content underneath — drawn with react-native-svg (already in the
// native build, no rebuild needed). Shared by LiveBroadcastScreen.tsx and LiveViewerScreen.tsx.
export default function EdgeGradient({ position, height = 140 }: { position: 'top' | 'bottom'; height?: number }) {
  return (
    <Svg
      style={[styles.gradientSvg, { height }, position === 'top' ? styles.gradientTop : styles.gradientBottom]}
      pointerEvents="none"
    >
      <Defs>
        <SvgLinearGradient
          id={`grad-${position}`}
          x1="0"
          y1={position === 'top' ? '0' : '1'}
          x2="0"
          y2={position === 'top' ? '1' : '0'}
        >
          <Stop offset="0" stopColor="#000000" stopOpacity={0.55} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#grad-${position})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  gradientSvg: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  gradientTop: {
    top: 0,
  },
  gradientBottom: {
    bottom: 0,
  },
});
