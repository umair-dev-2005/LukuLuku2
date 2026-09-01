import React from 'react';
import WebViewScreen from './WebViewScreen';

interface GamePlayScreenProps {
  gameUrl: string;
  gameName: string;
  onBack: () => void;
}

export default function GamePlayScreen({ gameUrl, gameName, onBack }: GamePlayScreenProps) {
  return <WebViewScreen url={gameUrl} title={gameName} onBack={onBack} />;
}