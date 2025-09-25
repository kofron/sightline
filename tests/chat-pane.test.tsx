import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import ChatPane from "../src/components/ChatPane";
import getInitialPrompt from "../src/reflection/getInitialPrompt";

beforeEach(() => {});

afterEach(() => {
  cleanup();
});

describe("ChatPane", () => {
  const createEvents = () => {
    const listeners: Array<(event: { payload: { text: string } }) => void> = [];
    return {
      emit: vi.fn(() => Promise.resolve()),
      listen: vi.fn(async (_event: string, handler: (event: { payload: { text: string } }) => void) => {
        listeners.push(handler);
        return () => {
          const index = listeners.indexOf(handler);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      }),
      trigger(payload: string) {
        listeners.forEach((handler) => {
          handler({ payload: { text: payload } });
        });
      },
    };
  };

  it("displays the initial prompt", () => {
    const events = createEvents();

    render(<ChatPane isDailyLogEmpty={true} events={events} />);

    expect(screen.getByTestId("chat-message").textContent).toBe(
      getInitialPrompt(true),
    );
  });

  it("emits chat messages when the user submits the form", async () => {
    const events = createEvents();

    render(<ChatPane isDailyLogEmpty={true} events={events} />);

    const input = screen.getByLabelText("Chat message") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "Hello" } });
    });

    const form = input.closest("form");
    expect(form).not.toBeNull();

    if (form) {
      await act(async () => {
        fireEvent.submit(form);
      });
    }

    expect(events.emit).toHaveBeenCalledWith("chat-message", { text: "Hello" });

    const messages = screen.getAllByTestId("chat-message");
    expect(messages.at(-1)?.textContent).toBe("Hello");
    expect(messages.at(-1)?.getAttribute("data-role")).toBe("user");
  });

  it("appends assistant messages received from the backend", async () => {
    const events = createEvents();

    render(<ChatPane isDailyLogEmpty={false} events={events} />);

    expect(events.listen).toHaveBeenCalledWith(
      "chat-response",
      expect.any(Function),
    );

    act(() => {
      events.trigger("Echo");
    });

    const messages = screen.getAllByTestId("chat-message");
    expect(messages.at(-1)?.textContent).toBe("Echo");
    expect(messages.at(-1)?.getAttribute("data-role")).toBe("assistant");
  });
});
