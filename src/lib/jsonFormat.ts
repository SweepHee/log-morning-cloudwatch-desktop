interface JsonSpan {
  end: number;
  formatted: string;
  start: number;
}

function findBalancedJsonEnd(message: string, start: number): number | null {
  const stack: string[] = [];
  let escaped = false;
  let inString = false;

  for (let index = start; index < message.length; index += 1) {
    const character = message[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const expectedOpening = character === "}" ? "{" : "[";
      if (stack.pop() !== expectedOpening) return null;
      if (stack.length === 0) return index + 1;
    }
  }

  return null;
}

function findJsonSpan(message: string): JsonSpan | null {
  for (let start = 0; start < message.length; start += 1) {
    if (message[start] !== "{" && message[start] !== "[") continue;

    const end = findBalancedJsonEnd(message, start);
    if (end === null) continue;

    try {
      const parsed: unknown = JSON.parse(message.slice(start, end));
      return { end, formatted: JSON.stringify(parsed, null, 2), start };
    } catch {
      // [스레드명] 같은 일반 로그 표기는 건너뛰고 다음 JSON 후보를 찾는다.
    }
  }

  return null;
}

export function formatJsonMessage(message: string): string | null {
  const span = findJsonSpan(message);
  if (!span) return null;

  const prefix = message.slice(0, span.start).trimEnd();
  const suffix = message.slice(span.end).trimStart();
  return [prefix, span.formatted, suffix].filter(Boolean).join("\n");
}
