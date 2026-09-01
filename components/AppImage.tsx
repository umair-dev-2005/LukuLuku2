import React from 'react';
import { Image as ExpoImage } from 'expo-image';

// Drop-in replacement for React Native's Image with disk + memory caching,
// so thumbnails and avatars don't re-download on every screen visit.
export function Image({ resizeMode, ...props }: any) {
  return (
    <ExpoImage
      cachePolicy="memory-disk"
      contentFit={props.contentFit || resizeMode || 'cover'}
      transition={100}
      {...props}
    />
  );
}

export default Image;
