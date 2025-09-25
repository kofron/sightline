import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import getInitialPrompt from "../reflection/getInitialPrompt";

type ChatEventsApi = {
  emit: typeof emit;
  listen: typeof listen;
};

const defaultEvents: ChatEventsApi = { emit, listen };

interface ChatMessagePayload {
  text: string;
}

interface ChatResponsePayload {
  text: string;
}

interface ChatPaneProps {
  isDailyLogEmpty: boolean;
  events?: ChatEventsApi;
}

type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

const CHAT_MESSAGE_EVENT = "chat-message";
const CHAT_RESPONSE_EVENT = "chat-response";

export function ChatPane({ isDailyLogEmpty, events }: ChatPaneProps) {
  const eventsApi = events ?? defaultEvents;
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const idCounterRef = useRef(0);

  const allocateId = useCallback((): string => {
    idCounterRef.current += 1;
    return idCounterRef.current.toString();
  }, []);

  const addUserMessage = useCallback(
    (text: string) => {
      setMessages((current) => [
        ...current,
        { id: allocateId(), role: "user", text },
      ]);
    },
    [allocateId],
  );

  const addAssistantMessage = useCallback(
    (text: string) => {
      setMessages((current) => [
        ...current,
        { id: allocateId(), role: "assistant", text },
      ]);
    },
    [allocateId],
  );

  const initialPrompt = useMemo(
    () => getInitialPrompt(isDailyLogEmpty),
    [isDailyLogEmpty],
  );

  useEffect(() => {
    let active = true;

    eventsApi
      .listen<ChatResponsePayload>(CHAT_RESPONSE_EVENT, (event) => {
        const payload = event.payload;
        if (payload?.text) {
          addAssistantMessage(payload.text);
        }
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      })
      .catch((err) => {
        console.error("failed to listen for chat responses", err);
      });

    return () => {
      active = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [addAssistantMessage, eventsApi]);

  const displayedMessages = useMemo<ChatMessage[]>(
    () => [
      { id: "initial", role: "system", text: initialPrompt },
      ...messages,
    ],
    [initialPrompt, messages],
  );

  const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = inputValue.trim();
      if (!trimmed || isSending) {
        return;
      }

      addUserMessage(trimmed);
      setInputValue("");
      setIsSending(true);

      const payload: ChatMessagePayload = { text: trimmed };
      void eventsApi
        .emit(CHAT_MESSAGE_EVENT, payload)
        .catch((err) => {
          console.error("failed to emit chat message", err);
        })
        .finally(() => {
          setIsSending(false);
        });
    },
    [addUserMessage, eventsApi, inputValue, isSending],
  );

  const disableSubmit = isSending || inputValue.trim().length === 0;

  return (
    <div className="chat-pane" data-testid="chat-pane">
      <ul className="chat-pane__messages" aria-live="polite">
        {displayedMessages.map((message) => (
          <li
            key={message.id}
            data-role={message.role}
            data-testid="chat-message"
            className={`chat-pane__message chat-pane__message--${message.role}`}
          >
            {message.text}
          </li>
        ))}
      </ul>
      <form className="chat-pane__input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          aria-label="Chat message"
          value={inputValue}
          onChange={handleInputChange}
          disabled={isSending}
        />
        <button type="submit" disabled={disableSubmit}>
          Send
        </button>
      </form>
    </div>
  );
}

export default ChatPane;
export type { ChatPaneProps };
