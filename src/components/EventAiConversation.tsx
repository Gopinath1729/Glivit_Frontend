import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useSendChatMessageMutation,
  type ChatMessageDto,
  type EventChatContextDto,
} from '@/src/services/aiApi';
import { KeyboardLift } from '@/src/components/ui/KeyboardAwareForm';
import { buildChatHistory } from '@/src/services/aiChatHistory';
import { formatAiPlainText } from '@/src/services/aiPlainText';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const CONNECTION_ERROR = 'Unable to connect to AI. Please try again.';
const QUICK_QUESTIONS = ['What happened?', 'Why is this severity?', 'What action should I take?'];

type ConversationMessage = ChatMessageDto & { id: string };

export function EventAiConversation({
  context,
  onBack,
}: {
  context: EventChatContextDto;
  onBack: () => void;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  const listRef = useRef<FlatList<ConversationMessage>>(null);
  const mountedRef = useRef(true);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: 'event-ready',
      role: 'assistant',
      content: `Event ${context.eventId} is ready. Ask me anything about this event.`,
      timestamp: new Date().toISOString(),
    },
  ]);
  const [sendMessage, { isLoading }] = useSendChatMessageMutation();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const showEvents = ['keyboardDidShow', 'keyboardWillShow'] as const;
    const hideEvents = ['keyboardDidHide', 'keyboardWillHide'] as const;
    const subs = [
      ...showEvents.map((e) =>
        Keyboard.addListener(e as any, () => {
          setKeyboardOpen(true);
          setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
        })
      ),
      ...hideEvents.map((e) =>
        Keyboard.addListener(e as any, () => setKeyboardOpen(false))
      ),
    ];
    return () => {
      mountedRef.current = false;
      subs.forEach((s) => s.remove());
    };
  }, []);

  const sendQuestion = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || isLoading) return;

      const userMessage: ConversationMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: question,
        timestamp: new Date().toISOString(),
      };
      // Only the last few real turns; the seeded "event is ready" line and any
      // local error placeholders are not part of the conversation.
      const history = buildChatHistory(
        messages.filter((message) => message.id !== 'event-ready')
      );
      setMessages((current) => [...current, userMessage]);
      setInput('');

      try {
        const response = await sendMessage({
          eventContext: context,
          history,
          message: question,
        }).unwrap();
        const answer = formatAiPlainText(response?.reply || 'No response');
        if (!answer) throw new Error('AI returned an empty response');
        if (!mountedRef.current) return;
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: answer,
            timestamp:
              typeof response.timestamp === 'string' && response.timestamp
                ? response.timestamp
                : new Date().toISOString(),
            source: response.source,
            mode: response.mode,
          },
        ]);
      } catch {
        if (!mountedRef.current) return;
        setMessages((current) => [
          ...current,
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: CONNECTION_ERROR,
            timestamp: new Date().toISOString(),
            source: 'NONE',
            mode: 'UNAVAILABLE',
          },
        ]);
      }
    },
    [context, isLoading, messages, sendMessage]
  );

  const rows = [
    ['Event ID', String(context.eventId)],
    ['Type', context.type],
    ['Vehicle', context.vehicle],
    ['Device ID', context.deviceId],
    ['Time', context.time],
    ['Severity', context.severity],
    ['Location', context.location],
    ['Description', context.description],
  ] as const;

  const bottomPadding = keyboardOpen ? spacing.md : Math.max(spacing.md, insets.bottom);

  return (
    <KeyboardLift style={styles.screen} useSafeArea={false}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.contextCard}>
            <View style={styles.contextHeader}>
              <Pressable
                accessibilityLabel="Back to events"
                accessibilityRole="button"
                hitSlop={10}
                onPress={onBack}
                style={styles.backButton}>
                <MaterialCommunityIcons color={c.primary} name="arrow-left" size={20} />
              </Pressable>
              <View style={styles.contextTitleBlock}>
                <Text style={styles.eyebrow}>SELECTED EVENT</Text>
                <Text numberOfLines={1} style={styles.title}>
                  {context.type}
                </Text>
              </View>
              <View style={styles.aiBadge}>
                <MaterialCommunityIcons color={c.primary} name="brain" size={18} />
                <Text style={styles.aiBadgeText}>AI</Text>
              </View>
            </View>
            {rows.map(([label, value]) => (
              <View key={label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{label}</Text>
                <Text selectable style={styles.detailValue}>
                  {value || 'Unavailable'}
                </Text>
              </View>
            ))}
          </View>
        }
        renderItem={({ item }) => {
          const user = item.role === 'user';
          return (
            <View style={[styles.message, user ? styles.userMessage : styles.aiMessage]}>
              {!user ? (
                <MaterialCommunityIcons color={c.primary} name="robot-outline" size={18} />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.messageText,
                    !user && styles.aiMessageText,
                    user && styles.userMessageText,
                  ]}>
                  {user ? item.content : formatAiPlainText(item.content, CONNECTION_ERROR)}
                </Text>
                {/* An answer built from the event's own data is a normal answer;
                    only a genuinely unreachable service is flagged. */}
                {!user && item.mode === 'UNAVAILABLE' && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                    <MaterialCommunityIcons
                      name="alert-circle-outline"
                      size={12}
                      color={c.warningOrange}
                    />
                    <Text style={{ fontSize: 10, color: c.warningOrange, marginLeft: 4 }}>
                      Assistant unavailable
                    </Text>
                  </View>
                )}
              </View>
            </View>
          );
        }}
        ListFooterComponent={
          <View>
            {isLoading ? (
              <View accessibilityLiveRegion="polite" style={[styles.message, styles.aiMessage]}>
                <ActivityIndicator color={c.primary} size="small" />
                <Text style={[styles.messageText, styles.aiMessageText]}>
                  AI is analysing this event...
                </Text>
              </View>
            ) : null}
            <View style={styles.quickQuestions}>
              {QUICK_QUESTIONS.map((question) => (
                <Pressable
                  key={question}
                  accessibilityRole="button"
                  disabled={isLoading}
                  onPress={() => void sendQuestion(question)}
                  style={({ pressed }) => [
                    styles.quickButton,
                    (pressed || isLoading) && styles.buttonMuted,
                  ]}>
                  <Text style={styles.quickText}>{question}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
      />

      <View style={[styles.composer, { paddingBottom: bottomPadding }]}>
        <TextInput
          accessibilityLabel="Question about selected event"
          editable={!isLoading}
          maxLength={2000}
          multiline
          onChangeText={setInput}
          onSubmitEditing={() => void sendQuestion(input)}
          placeholder="Ask about this event..."
          placeholderTextColor={c.textMuted}
          returnKeyType="send"
          style={styles.input}
          value={input}
        />
        <Pressable
          accessibilityLabel="Send question"
          accessibilityRole="button"
          accessibilityState={{ busy: isLoading, disabled: !input.trim() || isLoading }}
          disabled={!input.trim() || isLoading}
          onPress={() => void sendQuestion(input)}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || !input.trim() || isLoading) && styles.buttonMuted,
          ]}>
          {isLoading ? (
            <ActivityIndicator color={c.onPrimary} size="small" />
          ) : (
            <MaterialCommunityIcons color={c.onPrimary} name="send" size={20} />
          )}
        </Pressable>
      </View>
    </KeyboardLift>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.sm, padding: spacing.md, paddingBottom: spacing.lg },
    contextCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: 0,
      marginBottom: spacing.sm,
      overflow: 'hidden',
      padding: spacing.md,
    },
    contextHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    backButton: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    contextTitleBlock: { flex: 1, minWidth: 0 },
    eyebrow: { color: c.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    aiBadge: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    aiBadgeText: { color: c.primary, fontSize: typography.caption, fontWeight: '900' },
    detailRow: {
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingVertical: 7,
    },
    detailLabel: { color: c.textMuted, fontSize: typography.caption, width: 82 },
    detailValue: { color: c.textPrimary, flex: 1, fontSize: typography.caption, fontWeight: '600' },
    message: {
      alignItems: 'flex-start',
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: spacing.sm,
      maxWidth: '92%',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    aiMessage: {
      alignSelf: 'flex-start',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: StyleSheet.hairlineWidth * 2,
      maxWidth: '100%',
      width: '100%',
    },
    userMessage: { alignSelf: 'flex-end', backgroundColor: c.primary, maxWidth: '84%' },
    messageText: { color: c.textPrimary, flexShrink: 1, fontSize: typography.body, lineHeight: 20 },
    aiMessageText: { flex: 1, minWidth: 0, textAlign: 'left' },
    userMessageText: { color: c.onPrimary },
    quickQuestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.sm },
    quickButton: {
      borderColor: c.primary,
      borderRadius: radius.pill,
      borderWidth: 1,
      paddingHorizontal: spacing.sm,
      paddingVertical: 7,
    },
    quickText: { color: c.primary, fontSize: typography.caption, fontWeight: '700' },
    composer: {
      alignItems: 'flex-end',
      backgroundColor: c.surface,
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    input: {
      backgroundColor: c.pageBackground,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      color: c.textPrimary,
      flex: 1,
      fontSize: typography.body,
      maxHeight: 120,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    sendButton: {
      alignItems: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.pill,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    buttonMuted: { opacity: 0.45 },
  });
