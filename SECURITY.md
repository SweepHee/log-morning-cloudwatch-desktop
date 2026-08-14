# 보안 안내

로그 모닝은 AWS 자격 증명과 CloudWatch 로그를 외부 개발자 서버로 전송하지 않습니다.

- AWS Secret Access Key는 macOS Keychain 또는 Windows Credential Manager에만 저장합니다.
- 실제 `log-sources.json`, `.env`, 인증서와 개인 키는 공개 저장소에 커밋하지 마세요.
- 이슈에 실제 로그, 고객 정보, AWS 계정 번호 또는 자격 증명을 첨부하지 마세요.
- 보안 취약점은 공개 이슈 대신 GitHub의 비공개 보안 취약점 신고 기능을 이용해주세요.

AWS 키가 노출됐다고 의심되면 즉시 해당 키를 비활성화·삭제하고 CloudTrail을 확인하세요.
