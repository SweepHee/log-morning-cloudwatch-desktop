import { describe, expect, it } from "vitest";
import { formatJsonMessage } from "./jsonFormat";

describe("JSON 로그 정렬", () => {
  it("객체 로그를 키 순서를 유지한 채 두 칸 들여쓰기한다", () => {
    expect(formatJsonMessage('{"event":"SCHEDULE_CHANGE","paid":true,"amount":3069}')).toBe(
      `{
  "event": "SCHEDULE_CHANGE",
  "paid": true,
  "amount": 3069
}`,
    );
  });

  it("배열 로그도 정렬한다", () => {
    expect(formatJsonMessage('[{"id":1},{"id":2}]')).toBe(`[
  {
    "id": 1
  },
  {
    "id": 2
  }
]`);
  });

  it("설명 뒤에 포함된 중첩 JSON만 찾아 설명과 함께 정렬한다", () => {
    expect(
      formatJsonMessage(
        '[FESTA 응답] body: {"status":"fail","data":{"errorCd":"ERR006","errorMsg":"쿠폰 발급 가능 시간이 아닙니다."}}',
      ),
    ).toBe(`[FESTA 응답] body:
{
  "status": "fail",
  "data": {
    "errorCd": "ERR006",
    "errorMsg": "쿠폰 발급 가능 시간이 아닙니다."
  }
}`);
  });

  it("접두어 종류와 무관하게 배열 JSON과 뒤쪽 설명을 보존한다", () => {
    expect(formatJsonMessage('response payload => [{"id":1},{"id":2}] elapsed=12ms')).toBe(
      `response payload =>
[
  {
    "id": 1
  },
  {
    "id": 2
  }
]
elapsed=12ms`,
    );
  });

  it("JSON 문자열 안의 괄호와 이스케이프 문자를 경계로 오해하지 않는다", () => {
    expect(formatJsonMessage('payload={"message":"괄호 } 와 \\"인용\\" 포함","ok":true}')).toBe(
      `payload=
{
  "message": "괄호 } 와 \\"인용\\" 포함",
  "ok": true
}`,
    );
  });

  it("일반 문자열과 깨진 JSON은 원문 표시 대상으로 둔다", () => {
    expect(formatJsonMessage("일반 로그 메시지")).toBeNull();
    expect(formatJsonMessage('{"broken":}')).toBeNull();
    expect(formatJsonMessage("[elastic-1] INFO 정상 처리")).toBeNull();
  });
});
