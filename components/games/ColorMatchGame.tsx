import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors as themeColors, spacing, fontSize, borderRadius } from '../../lib/theme';

const GAME_ROUNDS = 15;
const TIME_PER_ROUND = 3000; // ms

const COLOR_MAP: { [key: string]: string } = {
  ROOD: '#FF3B30',
  BLAUW: '#007AFF',
  GROEN: '#34C759',
  GEEL: '#FFCC00',
  PAARS: '#AF52DE',
  ORANJE: '#FF9500',
};

const COLOR_NAMES = Object.keys(COLOR_MAP);

interface ColorMatchGameProps {
  onGameEnd: (score: number) => void;
}

function getRandomColor() {
  return COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)];
}

export default function ColorMatchGame({ onGameEnd }: ColorMatchGameProps) {
  const [round, setRound] = useState(0);
  const [score, setScore] = useState(0);
  const [displayWord, setDisplayWord] = useState('');
  const [displayColor, setDisplayColor] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [gameOver, setGameOver] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nextRound = useCallback(() => {
    if (round >= GAME_ROUNDS) {
      setGameOver(true);
      onGameEnd(score);
      return;
    }

    const word = getRandomColor();
    // The actual color shown (may differ from word)
    const isMatch = Math.random() > 0.5;
    const actualColor = isMatch ? word : getRandomColor();

    // Options: "Ja, klopt" or "Nee, klopt niet"
    setDisplayWord(word);
    setDisplayColor(COLOR_MAP[actualColor]);
    setOptions(isMatch ? ['correct', 'wrong'] : ['wrong', 'correct']);
    setFeedback(null);
  }, [round, score]);

  useEffect(() => {
    nextRound();
  }, []);

  const handleAnswer = (isCorrect: boolean) => {
    const wordColor = Object.entries(COLOR_MAP).find(([, v]) => v === displayColor)?.[0];
    const matches = wordColor === displayWord;
    const userSaysMatch = isCorrect;
    const correct = (matches && userSaysMatch) || (!matches && !userSaysMatch);

    if (correct) {
      setScore((s) => s + 1);
      setFeedback('correct');
    } else {
      setFeedback('wrong');
    }

    setTimeout(() => {
      setRound((r) => {
        const next = r + 1;
        if (next >= GAME_ROUNDS) {
          setGameOver(true);
          onGameEnd(correct ? score + 1 : score);
        } else {
          const word = getRandomColor();
          const isMatch = Math.random() > 0.5;
          const actualColor = isMatch ? word : getRandomColor();
          setDisplayWord(word);
          setDisplayColor(COLOR_MAP[actualColor]);
          setOptions(isMatch ? ['correct', 'wrong'] : ['wrong', 'correct']);
          setFeedback(null);
        }
        return next;
      });
    }, 600);
  };

  const resetGame = () => {
    setRound(0);
    setScore(0);
    setGameOver(false);
    nextRound();
  };

  if (gameOver) {
    return (
      <View style={styles.container}>
        <Text style={styles.gameOverTitle}>Game Over!</Text>
        <Text style={styles.finalScore}>{score}/{GAME_ROUNDS}</Text>
        <Text style={styles.resultText}>
          {score >= 12 ? 'Uitstekend!' : score >= 8 ? 'Goed gedaan!' : 'Blijf oefenen!'}
        </Text>
        <TouchableOpacity style={styles.resetBtn} onPress={resetGame}>
          <Ionicons name="refresh" size={20} color={themeColors.tapIn} />
          <Text style={styles.resetBtnText}>Opnieuw</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.progress}>
        <Text style={styles.progressText}>{round + 1}/{GAME_ROUNDS}</Text>
        <Text style={styles.scoreText}>Score: {score}</Text>
      </View>

      <Text style={styles.question}>Komt de kleur overeen met het woord?</Text>

      <View style={styles.wordContainer}>
        <Text style={[styles.colorWord, { color: displayColor }]}>
          {displayWord}
        </Text>
      </View>

      {feedback && (
        <View style={[styles.feedbackBadge, feedback === 'correct' ? styles.correctBg : styles.wrongBg]}>
          <Ionicons
            name={feedback === 'correct' ? 'checkmark-circle' : 'close-circle'}
            size={20}
            color={feedback === 'correct' ? themeColors.success : themeColors.error}
          />
          <Text style={[styles.feedbackText, { color: feedback === 'correct' ? themeColors.success : themeColors.error }]}>
            {feedback === 'correct' ? 'Correct!' : 'Fout!'}
          </Text>
        </View>
      )}

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.answerBtn, styles.yesBtn]}
          onPress={() => handleAnswer(true)}
          disabled={!!feedback}
        >
          <Ionicons name="checkmark" size={28} color="#FFF" />
          <Text style={styles.answerBtnText}>Ja, klopt</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.answerBtn, styles.noBtn]}
          onPress={() => handleAnswer(false)}
          disabled={!!feedback}
        >
          <Ionicons name="close" size={28} color="#FFF" />
          <Text style={styles.answerBtnText}>Nee</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  progress: { flexDirection: 'row', gap: spacing.xl, marginBottom: spacing.xl },
  progressText: { color: themeColors.textSecondary, fontSize: fontSize.md },
  scoreText: { color: themeColors.tapIn, fontSize: fontSize.md, fontWeight: '700' },
  question: { color: themeColors.textSecondary, fontSize: fontSize.md, marginBottom: spacing.xxl },
  wordContainer: {
    width: 200,
    height: 120,
    borderRadius: borderRadius.xl,
    backgroundColor: themeColors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  colorWord: { fontSize: 36, fontWeight: '900' },
  feedbackBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    marginBottom: spacing.lg,
  },
  correctBg: { backgroundColor: '#E8F5E9' },
  wrongBg: { backgroundColor: '#FFEBEE' },
  feedbackText: { fontSize: fontSize.md, fontWeight: '600' },
  buttons: { flexDirection: 'row', gap: spacing.lg },
  answerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius.lg,
  },
  yesBtn: { backgroundColor: themeColors.success },
  noBtn: { backgroundColor: themeColors.primary },
  answerBtnText: { color: '#FFF', fontSize: fontSize.lg, fontWeight: '700' },
  gameOverTitle: { color: themeColors.text, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.md },
  finalScore: { color: themeColors.tapIn, fontSize: 64, fontWeight: '800' },
  resultText: { color: themeColors.textSecondary, fontSize: fontSize.lg, marginBottom: spacing.xl },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: themeColors.surfaceLight,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.full,
  },
  resetBtnText: { color: themeColors.tapIn, fontSize: fontSize.md, fontWeight: '600' },
});
