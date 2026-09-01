import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';

const { width } = Dimensions.get('window');
const GRID_SIZE = 4;
const CARD_GAP = 8;
const CARD_SIZE = (width - spacing.lg * 2 - CARD_GAP * (GRID_SIZE - 1)) / GRID_SIZE;

const EMOJIS = ['🎵', '🎬', '🎮', '🌟', '🔥', '💎', '🎯', '🎪'];

interface MemoryGameProps {
  onGameEnd: (score: number) => void;
}

export default function MemoryGame({ onGameEnd }: MemoryGameProps) {
  const [cards, setCards] = useState<{ id: number; emoji: string; flipped: boolean; matched: boolean }[]>([]);
  const [flipped, setFlipped] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [matches, setMatches] = useState(0);
  const [gameStarted, setGameStarted] = useState(false);
  const [startTime, setStartTime] = useState(0);

  const initGame = useCallback(() => {
    const shuffled = [...EMOJIS, ...EMOJIS]
      .sort(() => Math.random() - 0.5)
      .map((emoji, i) => ({ id: i, emoji, flipped: false, matched: false }));
    setCards(shuffled);
    setFlipped([]);
    setMoves(0);
    setMatches(0);
    setGameStarted(true);
    setStartTime(Date.now());
  }, []);

  useEffect(() => {
    initGame();
  }, [initGame]);

  const handleCardPress = (index: number) => {
    if (flipped.length === 2) return;
    if (cards[index].flipped || cards[index].matched) return;

    const newCards = [...cards];
    newCards[index].flipped = true;
    setCards(newCards);

    const newFlipped = [...flipped, index];
    setFlipped(newFlipped);

    if (newFlipped.length === 2) {
      setMoves((m) => m + 1);
      const [first, second] = newFlipped;
      if (newCards[first].emoji === newCards[second].emoji) {
        newCards[first].matched = true;
        newCards[second].matched = true;
        setCards(newCards);
        setMatches((m) => {
          const newMatches = m + 1;
          if (newMatches === EMOJIS.length) {
            const timeTaken = Math.floor((Date.now() - startTime) / 1000);
            const score = Math.max(100 - (moves * 2) - timeTaken, 10);
            setTimeout(() => onGameEnd(score), 500);
          }
          return newMatches;
        });
        setFlipped([]);
      } else {
        setTimeout(() => {
          newCards[first].flipped = false;
          newCards[second].flipped = false;
          setCards([...newCards]);
          setFlipped([]);
        }, 800);
      }
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Zetten</Text>
          <Text style={styles.statValue}>{moves}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Paren</Text>
          <Text style={styles.statValue}>{matches}/{EMOJIS.length}</Text>
        </View>
        <TouchableOpacity style={styles.resetBtn} onPress={initGame}>
          <Ionicons name="refresh" size={20} color={colors.tapIn} />
        </TouchableOpacity>
      </View>

      <View style={styles.grid}>
        {cards.map((card, index) => (
          <TouchableOpacity
            key={card.id}
            style={[
              styles.card,
              card.flipped || card.matched ? styles.cardFlipped : styles.cardBack,
              card.matched && styles.cardMatched,
            ]}
            onPress={() => handleCardPress(index)}
            activeOpacity={0.7}
            disabled={card.matched}
          >
            {card.flipped || card.matched ? (
              <Text style={styles.emoji}>{card.emoji}</Text>
            ) : (
              <Ionicons name="help" size={28} color={colors.textTertiary} />
            )}
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg },
  stats: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xxl,
    marginBottom: spacing.xl,
  },
  stat: { alignItems: 'center' },
  statLabel: { color: colors.textSecondary, fontSize: fontSize.xs },
  statValue: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  resetBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: CARD_GAP,
    justifyContent: 'center',
  },
  card: {
    width: CARD_SIZE,
    height: CARD_SIZE,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardBack: {
    backgroundColor: colors.surfaceLight,
    borderWidth: 2,
    borderColor: colors.borderLight,
  },
  cardFlipped: {
    backgroundColor: '#E3F2FD',
    borderWidth: 2,
    borderColor: colors.tapIn,
  },
  cardMatched: {
    backgroundColor: '#E8F5E9',
    borderColor: colors.success,
    opacity: 0.7,
  },
  emoji: { fontSize: 32 },
});
