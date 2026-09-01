import React from 'react';
import { Text, Linking } from 'react-native';
import { colors } from '../lib/theme';

export default function LinkedText({ children, style }: { children?: string | null; style?: any }) {
  const text = children || '';
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts = text.split(urlRegex);

  if (parts.length === 1) {
    return <Text style={style}>{text}</Text>;
  }

  return (
    <Text style={style}>
      {parts.map((part, index) => {
        const isUrl = urlRegex.test(part);
        urlRegex.lastIndex = 0;

        if (!isUrl) {
          return <Text key={index}>{part}</Text>;
        }

        const url = part.startsWith('http') ? part : `https://${part}`;
        return (
          <Text
            key={index}
            style={{ color: colors.tapIn, textDecorationLine: 'underline' }}
            onPress={() => Linking.openURL(url)}
          >
            {part}
          </Text>
        );
      })}
    </Text>
  );
}