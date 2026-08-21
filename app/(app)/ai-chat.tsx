import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AiCommandCentrePanel } from '@/src/components/AiCommandCentrePanel';
import { useSendChatMessageMutation, type ChatMessageDto } from '@/src/services/aiApi';
import { buildChatHistory, CHAT_GREETING } from '@/src/services/aiChatHistory';
import { formatAiPlainText } from '@/src/services/aiPlainText';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const CONNECTION_ERROR = 'Unable to connect to AI. Please try again.';

function messageTime(timestamp?: string) {
  const parsed = timestamp ? new Date(timestamp) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type ChatMessage = ChatMessageDto & {
  isError?: boolean;
  originalInput?: string;
};

export default function AiChatScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [activeTab, setActiveTab] = useState<'chat' | 'insights'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: CHAT_GREETING,
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [sendMessage, { isLoading }] = useSendChatMessageMutation();
  const listRef = useRef<FlatList>(null);
  const sendInFlightRef = useRef(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const resetChatSession = useCallback(() => {
    setMessages([
      {
        role: 'assistant',
        content: CHAT_GREETING,
        timestamp: new Date().toISOString(),
      },
    ]);
    setInput('');
    setActiveTab('chat');
    sendInFlightRef.current = false;
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Screen focused: ensure in-flight status is clean
      sendInFlightRef.current = false;
      return () => {
        sendInFlightRef.current = false;
      };
    }, [])
  );

  useEffect(() => {
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
    return () => subs.forEach((s) => s.remove());
  }, []);

  const handleSend = useCallback(async (retryInput?: string) => {
    const textToSend = typeof retryInput === 'string' ? retryInput : input.trim();
    if (!textToSend || isLoading || sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    const userMsg: ChatMessage = {
      role: 'user',
      content: textToSend,
      timestamp: new Date().toISOString(),
    };

    if (typeof retryInput !== 'string') {
      setMessages((prev) => [...prev, userMsg]);
      setInput('');
    } else {
      setMessages((prev) => prev.filter((msg) => !msg.isError));
    }

    try {
      const response = await sendMessage({
        message: textToSend,
        history: buildChatHistory(messages),
      }).unwrap();

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: formatAiPlainText(response.reply, CONNECTION_ERROR),
          timestamp: response.timestamp || new Date().toISOString(),
          source: response.source,
          mode: response.mode,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'The message could not be sent. Please check your connection and try again.',
          timestamp: new Date().toISOString(),
          isError: true,
          originalInput: textToSend,
        },
      ]);
    } finally {
      sendInFlightRef.current = false;
    }
  }, [input, isLoading, messages, sendMessage]);

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.messageRow, isUser ? styles.userRow : styles.aiRow]}>
        {!isUser && (
          <View style={styles.aiIconWrapper}>
            <MaterialCommunityIcons name="robot-outline" size={16} color="#fff" />
          </View>
        )}
        <View style={[styles.bubbleContainer, isUser ? styles.userBubbleContainer : styles.aiBubbleContainer]}>
          <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
            <Text style={[styles.messageText, isUser ? styles.userMessageText : styles.aiMessageText]}>
              {isUser ? item.content : formatAiPlainText(item.content)}
            </Text>
            {!isUser && item.mode === 'UNAVAILABLE' && (
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
            {item.isError && (
              <Pressable
                onPress={() => handleSend(item.originalInput)}
                style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: c.primary, borderRadius: radius.pill, alignSelf: 'flex-start' }}
              >
                <MaterialCommunityIcons name="refresh" size={14} color="#fff" />
                <Text style={{ fontSize: 12, color: '#fff', marginLeft: 4, fontWeight: '600' }}>
                  Retry
                </Text>
              </Pressable>
            )}
          </View>
          <Text style={[styles.timestamp, isUser ? styles.userTimestamp : styles.aiTimestamp]}>
            {messageTime(item.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

  const quickPrompts = ['Fleet status', 'Maintenance', 'Alerts', 'Driver scores', 'Fuel report'];

  const QUICK_PROMPT_ICONS: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
    'Fleet status': 'chart-bar',
    'Maintenance': 'wrench',
    'Alerts': 'bell-outline',
    'Driver scores': 'star-outline',
    'Fuel report': 'gas-station',
  };

  const bottomPadding = keyboardOpen
    ? spacing.md
    : Math.max(spacing.md, insets.bottom);

  return (
    <View style={styles.screen}>
      {/* Top Header Tab Switcher */}
      <View style={styles.topTabBar}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'chat' }}
          onPress={() => setActiveTab('chat')}
          style={[styles.topTab, activeTab === 'chat' && styles.topTabActive]}>
          <MaterialCommunityIcons
            name="message-text-outline"
            size={18}
            color={activeTab === 'chat' ? c.primary : c.textMuted}
          />
          <Text style={[styles.topTabText, activeTab === 'chat' && styles.topTabTextActive]}>
            Chat
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'insights' }}
          onPress={() => setActiveTab('insights')}
          style={[styles.topTab, activeTab === 'insights' && styles.topTabActive]}>
          <MaterialCommunityIcons
            name="chart-timeline-variant"
            size={18}
            color={activeTab === 'insights' ? c.primary : c.textMuted}
          />
          <Text style={[styles.topTabText, activeTab === 'insights' && styles.topTabTextActive]}>
            AI Fleet Insights
          </Text>
        </Pressable>
      </View>

      {/* Tab Content */}
      {activeTab === 'insights' ? (
        <View style={{ flex: 1 }}>
          <AiCommandCentrePanel />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.chatContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 64 : 0}>
          <FlatList
            ref={listRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            data={messages}
            keyExtractor={(_, i) => String(i)}
            renderItem={renderItem}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            onLayout={() => listRef.current?.scrollToEnd({ animated: true })}
            ListFooterComponent={
              isLoading ? (
                <View style={styles.typingIndicator}>
                  <View style={styles.aiIconWrapper}>
                    <MaterialCommunityIcons name="robot-outline" size={16} color="#fff" />
                  </View>
                  <View style={styles.typingBubble}>
                    <ActivityIndicator size="small" color={c.primary} />
                    <Text style={styles.typingText}>Glivt AI is thinking...</Text>
                  </View>
                </View>
              ) : null
            }
          />

          {messages.length <= 1 && (
            <View style={styles.quickContainer}>
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={quickPrompts}
                keyExtractor={(item) => item}
                contentContainerStyle={styles.quickScrollContent}
                renderItem={({ item }) => (
                  <Pressable style={styles.quickChip} onPress={() => setInput(item)}>
                    <MaterialCommunityIcons
                      name={QUICK_PROMPT_ICONS[item] || 'help-circle-outline'}
                      size={14}
                      color={c.primary}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={styles.quickChipText}>{item}</Text>
                  </Pressable>
                )}
              />
            </View>
          )}

          <View style={[styles.inputArea, { paddingBottom: bottomPadding }]}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                placeholder="Ask anything about your fleet..."
                placeholderTextColor={c.textMuted}
                value={input}
                onChangeText={setInput}
                multiline
                maxLength={1000}
              />
            </View>

            <Pressable
              style={[styles.sendButton, (!input.trim() || isLoading) && styles.sendButtonDisabled]}
              onPress={() => handleSend()}
              disabled={!input.trim() || isLoading}>
              <MaterialCommunityIcons name="send" size={18} color="#fff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.pageBackground },
    topTabBar: {
      flexDirection: 'row',
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      borderBottomColor: c.border,
    },
    topTab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.md,
      gap: spacing.xs,
      borderBottomWidth: 3,
      borderBottomColor: 'transparent',
    },
    topTabActive: {
      borderBottomColor: c.primary,
    },
    topTabText: {
      fontSize: typography.body,
      fontWeight: '600',
      color: c.textMuted,
    },
    topTabTextActive: {
      color: c.primary,
      fontWeight: '800',
    },
    chatContainer: { flex: 1 },
    messageList: { flex: 1 },
    messageListContent: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.lg },
    messageRow: {
      flexDirection: 'row',
      width: '100%',
    },
    userRow: {
      justifyContent: 'flex-end',
    },
    aiRow: {
      justifyContent: 'flex-start',
      gap: spacing.sm,
    },
    aiIconWrapper: {
      backgroundColor: c.primary,
      borderRadius: radius.pill,
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
      flexShrink: 0,
    },
    bubbleContainer: {
      maxWidth: '82%',
      gap: 4,
    },
    userBubbleContainer: {
      alignItems: 'flex-end',
    },
    aiBubbleContainer: {
      alignItems: 'flex-start',
      flex: 1,
    },
    bubble: {
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    userBubble: {
      backgroundColor: c.primary,
      borderBottomRightRadius: 2,
    },
    aiBubble: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderBottomLeftRadius: 2,
    },
    messageText: {
      fontSize: typography.body,
      lineHeight: 21,
    },
    userMessageText: {
      color: '#fff',
    },
    aiMessageText: {
      color: c.textPrimary,
    },
    timestamp: {
      fontSize: 10,
      color: c.textMuted,
    },
    userTimestamp: {
      marginRight: 4,
    },
    aiTimestamp: {
      marginLeft: 4,
    },
    typingIndicator: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
    typingBubble: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    typingText: { color: c.textMuted, fontSize: typography.caption, fontStyle: 'italic' },
    quickContainer: {
      paddingVertical: spacing.sm,
      backgroundColor: 'transparent',
    },
    quickScrollContent: {
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    quickChip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
    },
    quickChipText: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '600' },
    inputArea: {
      flexDirection: 'row',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      gap: spacing.sm,
      alignItems: 'center',
    },
    inputContainer: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.pageBackground,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      minHeight: 44,
      maxHeight: 120,
    },
    input: {
      flex: 1,
      paddingVertical: Platform.OS === 'ios' ? 10 : 6,
      color: c.textPrimary,
      fontSize: typography.body,
      maxHeight: 100,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: {
      backgroundColor: c.border,
      opacity: 0.7,
    },
  });
