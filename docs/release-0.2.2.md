# ResearchBunny 0.2.2

2026-10-01 누적 변경 릴리스.

- 아카이브·선택 문헌·분류·컬렉션의 PDF 원문 확보, 논문별 결과 및 실패 항목 재시도.
- PDF 파싱·논문 정보 검증·해시 저장과 병합/삭제/백업/복원 연동.
- 설치된 Codex CLI 중 최신 버전 선택, 최신 데스크톱 CLI 경로 인식 및 AI 입력량 제한 설명 개선.
- 현재 그래프 안에서 받은 인용 수에 따른 24~64px 로그 척도 노드 크기. 중복·자기 인용, 관련 문헌 연결 및 확인 필요 인용은 제외.
- 기존 디자인 참고 이미지와 기능 구현·검증 문서 포함.

검증: 통합 테스트 86개, 타입 검사, 전체 lint, `git diff --check` 통과.
stable 패키징 후 압축을 푼 앱에서 제한된 PATH로 PDF 처리·아카이브·서지 내보내기·백업/복원·영구 삭제 smoke test 통과.
앱의 `codesign --verify --deep --strict` 및 DMG의 `hdiutil verify` 통과.

`/Applications/ResearchBunny.app`을 교체하고 실행했다. Accelerated TMS 아카이브 111편의 실제 그래프에서 노드 크기 차이와 범례를 확인했다.
설치된 renderer와 service는 검증한 배포 앱과 동일하며, 교체 전후 전체 라이브러리의 논문·프로젝트 연결·프로젝트·첨부 개수를 확인했다.
이전 앱은 `~/Library/Application Support/ResearchBunny/app-backups/20261001-210758/ResearchBunny.app`에 보관했다.

배포 파일: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg`.
서명은 로컬 ad-hoc이며 Developer ID 서명과 Apple 공증은 수행하지 않았다.
