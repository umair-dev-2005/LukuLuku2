import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';

const QUESTIONS = [
  { q: 'Wat is de hoofdstad van Suriname?', options: ['Paramaribo', 'Georgetown', 'Cayenne', 'Brasilia'], answer: 0 },
  { q: 'Welke rivier stroomt door Suriname?', options: ['Amazone', 'Surinamerivier', 'Nijl', 'Donau'], answer: 1 },
  { q: 'In welk jaar werd Suriname onafhankelijk?', options: ['1960', '1975', '1980', '1970'], answer: 1 },
  { q: 'Wat is de munteenheid van Suriname?', options: ['Dollar', 'Euro', 'SRD', 'Gulden'], answer: 2 },
  { q: 'Hoeveel districten heeft Suriname?', options: ['8', '10', '12', '15'], answer: 1 },
  { q: 'Welk land grenst NIET aan Suriname?', options: ['Brazilië', 'Guyana', 'Venezuela', 'Frans-Guyana'], answer: 2 },
  { q: 'Wat is de hoogste berg van Suriname?', options: ['Julianatop', 'Tafelberg', 'Voltzberg', 'Kasikasima'], answer: 0 },
  { q: 'Welke taal is de officiële taal van Suriname?', options: ['Sranantongo', 'Nederlands', 'Engels', 'Spaans'], answer: 1 },
  { q: 'LukuLuku betekent...?', options: ['Kijken kijken', 'Spelen spelen', 'Dansen dansen', 'Zingen zingen'], answer: 0 },
  { q: 'Wat is de populairste sport in Suriname?', options: ['Cricket', 'Voetbal', 'Basketbal', 'Tennis'], answer: 1 },
];

interface QuizGameProps {
  onGameEnd: (score: number) => void;
}

export default function QuizGame({ onGameEnd }: QuizGameProps) {
  const [currentQ, setCurrentQ] = useState(0);
  const [score, setScore] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [gameOver, setGameOver] = useState(false);

  const question = QUESTIONS[currentQ];

  const handleAnswer = (index: number) => {
    if (selected !== null) return;
    setSelected(index);
    const correct = index === question.answer;
    if (correct) setScore((s) => s + 1);

    setShowResult(true);
    setTimeout(() => {
      if (currentQ + 1 >= QUESTIONS.length) {
        setGameOver(true);
        onGameEnd(correct ? score + 1 : score);
      } else {
        setCurrentQ((q) => q + 1);
        setSelected(null);
        setShowResult(false);
      }
    }, 1200);
  };

  const resetGame = () => {
    setCurrentQ(0);
    setScore(0);
    setSelected(null);
    setShowResult(false);
    setGameOver(false);
  };

  if (gameOver) {
    return (
      <View style={styles.container}>
        <Ionicons name="trophy" size={64} color="#FFD700" />
        <Text style={styles.gameOverTitle}>Quiz Klaar!</Text>
        <Text style={styles.finalScore}>{score}/{QUESTIONS.length}</Text>
        <Text style={styles.resultText}>
          {score >= 8 ? 'Uitstekend!' : score >= 5 ? 'Goed gedaan!' : 'Probeer het nog eens!'}
        </Text>
        <TouchableOpacity style={styles.resetBtn} onPress={resetGame}>
          <Ionicons name="refresh" size={20} color={colors.tapIn} />
          <Text style={styles.resetBtnText}>Opnieuw</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.progress}>Vraag {currentQ + 1}/{QUESTIONS.length}</Text>
        <Text style={styles.scoreDisplay}>Score: {score}</Text>
      </View>

      <View style={styles.questionCard}>
        <Text style={styles.questionText}>{question.q}</Text>
      </View>

      <View style={styles.options}>
        {question.options.map((option, i) => {
          let btnStyle = styles.optionBtn;
          let textStyle = styles.optionText;
          if (showResult && i === question.answer) {
            btnStyle = { ...styles.optionBtn, ...styles.correctOption };
            textStyle = { ...styles.optionText, color: '#FFF' };
          } else if (showResult && i === selected && i !== question.answer) {
            btnStyle = { ...styles.optionBtn, ...styles.wrongOption };
            textStyle = { ...styles.optionText, color: '#FFF' };
          }

          return (
            <TouchableOpacity
              key={i}
              style={btnStyle}
              onPress={() => handleAnswer(i)}
              disabled={selected !== null}
              activeOpacity={0.7}
            >
              <Text style={styles.optionLetter}>{String.fromCharCode(65 + i)}</Text>
              <Text style={textStyle}>{option}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  header: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: spacing.xl },
  progress: { color: colors.textSecondary, fontSize: fontSize.md },
  scoreDisplay: { color: colors.tapIn, fontSize: fontSize.md, fontWeight: '700' },
  questionCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xl,
    padding: spacing.xxl,
    width: '100%',
    marginBottom: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  questionText: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', textAlign: 'center', lineHeight: 26 },
  options: { width: '100%', gap: spacing.md },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  correctOption: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  wrongOption: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  optionLetter: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    textAlign: 'center',
    lineHeight: 32,
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    overflow: 'hidden',
  },
  optionText: { color: colors.text, fontSize: fontSize.md, fontWeight: '500', flex: 1 },
  gameOverTitle: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '800', marginTop: spacing.lg },
  finalScore: { color: colors.tapIn, fontSize: 64, fontWeight: '800', marginVertical: spacing.md },
  resultText: { color: colors.textSecondary, fontSize: fontSize.lg, marginBottom: spacing.xl },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.full,
  },
  resetBtnText: { color: colors.tapIn, fontSize: fontSize.md, fontWeight: '600' },
});
