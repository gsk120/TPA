# TPA Core 1단계 · 현행 구조와 회귀 기준

기준일 2026-11-17. Node.js ESM 진입점과 실제 `src/`, `sql/`, `test/`를 조사했다. `PRD.md` §32의 자연어 처리 기준과 §33의 반복일정 정책을 대조했다. 이번 작업의 산출물은 이 문서와 `test/tpa-core-regression.test.js`다.

## 1. Telegram에서 일정 저장과 응답까지

1. `src/main.js`가 Telegram 봇, Codex, Supabase PostgreSQL 풀과 `Families`를 초기화한다. 봇 단위 DB 잠금과 Telegram 수신 커서를 복원하고 `getUpdates` 폴링, 작업 소비, 알림 스케줄링, 발송을 같은 프로세스에서 실행한다.
2. `src/router.js#routeUpdate`가 Telegram 업데이트를 분기한다. 명령·멘션·`!`·봇 메시지 답장을 인식하고 비공개 그룹, 봇 관리자 권한, 사용자 그룹 소속과 활성 가족을 확인한다. 콜백은 버튼의 소유자·채팅·만료 시각도 검사한다. 텍스트 작업에는 `actor`, `chatId`, `messageId`, `sentAt`와 봇 메시지에 대한 `replyTo`를 담는다. `Store.ingest`가 가족별 작업과 수신 오프셋을 저장한다. 폴링 루프는 처리 후 봇 커서도 전진시킨다.
3. `main.js`의 worker 루프가 `Store.claim()`으로 작업을 임대하고 heartbeat로 임대를 연장한다. 계정 권한을 재확인하고 가족 설정을 읽어 `processJob(job, store, ai, now, signal, options)`을 호출한다. 자연어 접수 알림은 별도 발송 레코드로 큐에 넣는다. 실패는 worker에서 `Store.fail()`로 처리한다.
4. `processor.js`가 가족 범위의 일정과 요청자별 대화 상태, 봇 답장 참조를 읽는다. 명령어·고정 조회·상세·버튼·단순 완료에 직접 경로가 있다. 자연어는 LangGraph에 전달하고 `natural.js`가 대상 검색, 조회, 데이터 검증 및 저장 계획을 맡는다.
5. 저장 직전 `options.authorize`를 호출한다. `Store.finish()`는 작업 임대, 확인 재개 토큰, 일정·설정 버전을 검증한다. 변경, 이력, 대화 상태, 응답 발송 레코드, 작업 완료 표시를 한 트랜잭션으로 묶는다. 별도로 실행되는 발송 루프가 응답을 Telegram에 보내고 반환된 메시지별 참조를 DB에 연결한다. `processor.js#schedule`의 일일·주간 브리핑과 예약 알림은 인터랙티브 요청과 별도 경로다.

## 2. 주요 파일과 의존성

| 파일 | 현재 책임과 직접 연결 |
| --- | --- |
| `src/main.js` | 진입점과 실행 루프. `Telegram`, `Families`, `Store.openPool`, `Codex`, `routeUpdate`, `processJob`, `schedule`을 조립한다. |
| `src/router.js`, `src/families.js`, `src/telegram.js` | Telegram 입력 해석, 채팅·구성원 검증, 가족 설정과 가족별 `Store` 제공, 메시지 분할·전송. 현재 `router.js`는 Telegram 입력 라우터다. |
| `src/processor.js` | 가족 작업 처리와 커밋 조율. `context.js`, `workflow.js`, `natural.js`, 조회·포맷·버튼 모듈을 호출한다. 버튼 선택/되돌리기와 브리핑·알림 예약도 처리한다. |
| `src/context.js` | 고정 명령 인식, 대상 후보 매칭, 짧은 후속 응답 판별, 질문·대화·메시지 참조 구성. 시간대·날짜 검사에 `time.js`를 사용하며 저장은 호출자가 수행한다. |
| `src/storage.js` | 가족 단위 PostgreSQL 저장소. 작업 임대, 일정·이력·설정, `runtime` 상태, 발송 큐와 원자적 커밋을 관리한다. 반복일정 저장과 조회는 `schedule-store.js`에 위임한다. |
| `src/assistant/workflow.js` | `StateGraph`의 분류·업무 노드·확인 중단·재개. `schema.js`의 의도 검증과 호출자가 전달한 AI 및 두 계획 함수를 사용한다. 체크포인트를 직렬화해 `processor.js`에 반환한다. |
| `src/assistant/codex.js`, `src/assistant/schema.js`, `src/assistant/date-time-policy.js` | 의도·답변 프롬프트와 출력 스키마, 날짜 해석 지침, Codex CLI 자식 프로세스 실행 및 구조화 결과 파싱. |
| `src/natural.js`, `src/tasks.js`, `src/retrieval.js` | 신규 요청과 기존 대상 요청의 계획 수립, 후보·의도·버전 검증, 일정 상태 전이 및 기간·상태 조회. |
| `src/weekly.js`, `src/schedule-store.js`, `src/recurrence.js` | 반복 초안을 시리즈와 RRULE로 변환하고 회차를 계산한다. 시리즈, 연결 회차, 예외, 버전, 이력과 조회용 투영을 관리한다. |

### LangGraph와 Codex 호출

`classify` → 의도별 노드 → `END` 또는 `confirm`이다. `create`, `retrieve`, `settings`, `unknown`은 분류 응답에 구조화된 결과를 포함하므로 통상 분류 호출 한 번으로 처리한다. 변경·완료·취소·상세·이력·혼합 의도는 필요에 따라 후보·이력·커버리지를 읽은 후 `answer`를 호출한다. 유일한 단순 완료, 명령어, 고정 조회는 모델 없이 처리할 수 있다. 재개 시 기존 그래프 의도를 사용하며, 반복 취소 범위가 미정이었던 경우 원래 기준 시각과 시간대로 다시 분류한다.

`Codex`는 `classify`와 `answer`별 프롬프트 및 JSON 스키마를 작성한다. 임시 디렉터리에서 `codex exec`를 읽기 전용·임시 세션으로 실행하고 stdin으로 프롬프트를 전달해 출력 파일을 읽는다. 환경변수 허용 목록, 작업 취소 신호·타임아웃 및 출력 크기 제한을 적용한다. 모델 결과는 제안이며 실제 권한, 대상, 필드, 버전과 저장 여부를 애플리케이션이 검사한다.

## 3. 확인 질문의 저장과 재개

- 후보 중복은 코드에서 직접 질문과 선택 버튼을 만들 수 있다. 모델의 `clarification`은 후보 ID, 제안 변경값, 미결정 항목을 검증하고, 반복 등록에 정보가 부족하면 `seriesDraft`를 보존한다. `nextConversation`은 `requestId`, 원문, `startedAt`, `timeZone`, 후보 순서, 최근 네 턴과 2시간 만료 시각을 저장할 상태로 만든다. 직접 상세 조회의 후보 선택은 별도의 읽기 전용 경로다.
- LangGraph의 `confirm` 노드가 `interrupt()`를 호출한다. `PausedRequestSaver`가 `MemorySaver`의 내부 `storage`, `writes`를 V8 직렬화 후 base64로 저장한다. 상태에는 `threadId`, `snapshot`, 회차별 재개 `token`, `chatId`, 후보 버전을 담는다. `Store.finish`가 `assistant.runtime`의 `conversation:<actor>`와 대기 질문의 발송 레코드를 함께 커밋한다. 별도의 `assistant.context`에는 가족별 최근 40개 로그 행을 남긴다.
- 발송 성공 후 메시지 ID·채팅·원 요청자·`requestId`·`workflowToken`·후보 참조를 `message:<messageId % 1000>`에 저장한다. 메시지 ID 전체를 대조하며 참조 TTL은 30일이다. 질문에 답할 수 있는 시간은 대화의 2시간 TTL도 충족해야 한다. 버튼은 별도 `button:<token>` 상태와 자체 만료·소비 검사를 거친다.
- 다음 작업이 같은 가족·사용자의 상태를 다시 읽는다. 명시적 답장은 채팅·요청 ID·토큰·소유자·만료를 확인하고, 독립 요청과 구분 가능한 일부 짧은 텍스트도 연결한다. 새 `PausedRequestSaver`가 DB 스냅샷을 역직렬화한 후 같은 `thread_id`에서 `Command({resume: ...})`로 실행을 잇는다. 커밋 시 저장된 토큰과 버전을 다시 확인해 이미 처리됐거나 변경된 대상을 보호한다. 대화가 재차 중단되면 새 토큰을 저장한다.
- 프로세스 재시작 후 DB에 커밋된 질문과 체크포인트를 다시 읽을 수 있다. 질문 발송과 메시지 참조 저장 사이에 중단된 경우 `Families.lock`은 남은 `sending` 레코드를 `uncertain`으로 바꾼다. 발송 성공과 참조 등록 사이의 공백에서는 해당 Telegram 메시지에 답해도 참조를 찾지 못할 수 있다. 통합 테스트는 같은 DB에서 새 `Store`와 그래프를 구성해 복원 경로를 실행한다.

## 4. 일반 일정과 반복일정

| 동작 | 일반 일정 | 반복일정 |
| --- | --- | --- |
| 등록 | 구조화 `actions.create` → `planChanges` → UUID·버전 1 → `assistant.tasks`와 `assistant.history`. | `answer.series` → `readSeriesDraft` / `planSeriesRegistration` → `Store.finish`의 `weekly-request` 예약 키 → `schedule_series`와 시리즈 이력. 회차별 신규 `tasks` 생성은 금지한다. |
| 수정·완료 | 기존 후보를 선택하고 `id`·`expectedVersion` 검증 후 버전을 올린다. 명확한 단순 완료는 직접 처리한다. | 한 회차 변경은 `applyOccurrenceChange`에서 필요시 `tasks`를 처음 저장하고 연결 회차·예외를 만들며 원래 앵커를 유지한다. 전체 규칙 편집은 `Store.updateScheduleSeries`에 저장 경로가 있다. 현재 Telegram 자연어에는 전체 규칙 편집 전용 흐름이 없다. |
| 취소 | `actions.update`로 `cancelled` 처리하고 예약 알림을 무효화한다. | 한 회차는 취소 예외를 남긴다. 전체 취소는 구조화된 `cancellation.scope=series`, 제목 및 선택적 시작일·시작월로 찾은 시리즈의 상태를 버전 검사 후 바꾼다. 범위가 모호하면 질문을 저장한다. |
| 조회 | `Store.calendarTasks`, `listTasks`, `retrieveTasks`와 기존 포맷으로 명령어 및 자연어를 지원한다. | 동일 조회에서 가상 회차와 연결 행을 합친다. `/list` 및 자연어 전체 조회는 오늘 포함 30일의 반복 회차를 표시하고 지정 기간 조회는 해당 범위로 투영한다. `/week`는 오늘부터 7일이다. |

기존 반복 일괄 등록에서 생성된 개별 일정은 기존 ID와 이력을 가진 일반 일정으로 남는다. `sql/calendar-sync.sql`은 로컬 반복일정과 향후 동기화용 테이블을 정의하며, 로컬 시리즈의 생성·편집·취소가 Google API 호출로 이어지는 실행 경로는 없다.

## 5. 회귀 테스트와 현행 차이

`test/tpa-core-regression.test.js`는 메모리 PGlite에 기존 스키마 두 개를 로드하고 `assistant_app` 권한으로 실행한다. 실제 `routeUpdate`, `Families`, 큐·스토리지, `processJob`, LangGraph를 사용하고 Telegram 요청 및 Codex 분류·응답을 고정 입력으로 대체한다. 발송 참조 복원은 Telegram 메시지 ID를 모의 발급해 `Store.deliveryResult`로 검증한다. 검증 범위는 앱의 분기와 영속화이며, 실제 모델의 자연어 해석 품질, Telegram 네트워크, 프로세스 종료·재기동, 운영 PostgreSQL의 동시 실행은 포함하지 않는다.

- `node --test test/tpa-core-regression.test.js` 성공 7건, 실패 0건.
- `npm.cmd test` 성공 121건, 실패 0건, 건너뜀 5건. Windows에서 기존 macOS 실행기 및 Unix 소켓 테스트가 건너뛰어졌다. 실행 환경은 Node.js v24.18.0이다.

| 검증 | 새 테스트의 확인 내용 |
| --- | --- |
| 일반 일정 등록·조회·수정·완료·취소 | `/list`와 완료 조회, 동일 UUID·버전, 메모 보존, 완료 시각과 이력, 직접 완료의 AI 우회. |
| 반복 등록·중복 방지·회차 변경 | 자정 전에 전송하고 이후에 처리해도 첫 회차가 보존된다. 같은 반복 요청은 새 시리즈를 만들지 않는다. 한 회차의 시각만 변경되고 시리즈와 다른 회차는 그대로다. |
| 질문·DB 복원·후속 답장·날짜 | 질문만 저장 후 새 `Store`와 새 그래프에서 체크포인트와 Telegram 참조를 읽는다. 자정 이후에도 최초 작업 시각·시간대·제안 날짜가 이어진다. 처리된 질문의 재답장은 저장을 반복하지 않는다. |
| 다른 사용자·채팅·만료 | 질문에 직접 답장한 다른 구성원, 기존 가족의 변경된 채팅 ID, 정확히 TTL에 도달한 대화에서 AI와 일정 저장이 실행되지 않는다. |
| 중복 일반 일정 | 동일 `update_id`의 처리 전·후 재전송은 한 작업·일정·이력만 남긴다. 새 `update_id`의 동일 문장은 별도 일반 일정으로 저장되는 현행 동작도 고정했다. |
| 일반 일정의 자정 경계 | 전송은 자정 전, 첫 작업 처리는 자정 후인 경우 분류와 `startedAt`이 작업 시각을 사용한다. 작업 시각대로 상대 날짜를 해석하는 모의 모델에서 제안 날짜가 사용자 전송 시각 기준보다 하루 늦어진다. |
| 직접 상세 질문의 채팅 이동 | 같은 가족·사용자가 그룹 ID 이동 후 답장 없이 `첫 번째`라고 보내면 이전 채팅의 상세 선택이 이어진다. 일정 및 이력 변경은 없다. |

기존 `calendar-schedule.test.js`는 전체 시리즈 규칙 변경, 전체/회차 취소, 예외·오래된 버전·트랜잭션 롤백을 보완한다. `context-storage.test.js`, `pending-request.test.js`와 `families.test.js`는 버튼 선택·되돌리기, 문맥과 요청 후보 순서, 가족 격리, 봇 커서와 동일 업데이트 재처리를 보완한다.

### 발견 사항과 Core 도입 위험

1. **최초 날짜 기준이 경로마다 다르다.** Telegram은 `sentAt`을 저장하지만 일반 분류 및 일반 질문 생성은 worker의 `now`를 쓴다. 일반 등록 재개는 `pendingRequest.startedAt`을 제공하면서 `now`에는 답변 시각을 둔다. 모델은 프롬프트에 따라 둘을 구분해야 하며, 프로그램은 일반 일정의 상대 날짜를 모든 경로에서 다시 계산하지 않는다. 반복 등록의 첫 회차 계산은 `sentAt` 또는 기존 `request.startedAt`을 사용한다. Core 도입 시 전송 시각과 처리 시각을 함께 전달하고, 날짜 정책 통일은 별도로 승인받아 변경할 사항이다.
2. **일반 일정 중복 방지 범위는 같은 작업 ID와 확인 재개다.** 같은 문장을 새 Telegram 업데이트로 보내면 서로 다른 UUID가 만들어진다. 같은 제목·시각의 의도된 복수 등록도 가능하므로 새 업데이트를 내용으로 중복 판정할지는 별도 요구사항이다. 반복 등록은 가족·요청자와 구조화된 규칙의 영속 키를 추가로 사용한다. 이 키에는 작업 ID나 계산된 첫 회차가 없으므로, 동일한 규칙으로 의도적으로 재등록하거나 취소한 규칙을 다시 등록하는 정책을 정의할 때 키 수명도 검토해야 한다.
3. **직접 상세 선택은 채팅 검사가 다르다.** LangGraph 질문의 답장 경로는 다른 채팅을 거부한다. `processor.js`의 직접 상세 경로는 답장 없는 선택에서 `chatId`를 비교하지 않아 같은 가족이 그룹을 이동한 후 동일 사용자가 이전 질문을 선택할 수 있다. 읽기 전용 경로에서 확인한 차이다. 향후 공통 라우팅에서 기존 상세 상태와 쓰기 가능한 재개 토큰을 같은 종류의 권한으로 취급하면 안 된다.
4. **체크포인트와 큐의 기존 계약을 보존해야 한다.** V8 스냅샷은 LangGraph의 내부 상태, 노드명과 버전에 의존한다. 그래프를 동시에 개편하면 배포 직전 질문의 복원에 영향을 줄 수 있다. 작업 임대, 재개 토큰 재검증, 최신 권한 확인과 단일 트랜잭션을 여러 모듈에 중복 구현하면 이중 저장 또는 질문만 남는 상태가 생길 수 있다.
5. **확인 컨텍스트는 사용자당 한 슬롯이다.** 새 요청이 `conversation:<actor>`에 기록되면 기존 질문이 교체될 수 있다. Telegram 메시지 참조도 가족당 1,000개 슬롯의 순환 키를 사용한다. TTL이 남아도 덮어쓴 참조는 사라지므로, 새 기능이 같은 슬롯을 쓰기 전에 교체 및 충돌 정책을 정해야 한다.

## 6. 다음 단계의 최소 Core 구성

같은 Node.js 프로세스에서 `main.js`의 worker가 `processJob`을 호출하는 한 지점을 `dispatchJob` 호출로 바꾼다. 이 위치에는 검증된 가족·사용자, 임대된 작업, 시간, 설정, AI, 권한 재검사 함수가 이미 있다. Telegram 입력 라우터와 Calendar 내부 LangGraph의 책임 경계도 유지된다. 첫 도입은 등록된 Calendar 하나로 전량 위임한다. Calendar 어댑터가 기존 인자를 그대로 `processJob`에 펼쳐 전달하므로 파일 이동 없이 명령, 자연어, 버튼 및 저장 경로를 감쌀 수 있다. 기존 `schedule`은 현재 scheduler 루프에서 그대로 호출한다.

TPA-Standards는 저장소 내부 JSDoc 구조 계약으로 둔다. 최초 인터페이스는 채널 입력 전달과 현재 실행 결과만 표현한다.

```ts
interface Skill {
  readonly id: string;
  handle(input: JobContext): Promise<string>;
}

interface JobContext {
  job: ClaimedJob;
  store: Store;
  ai: AssistantClient;
  now: Date;
  signal?: AbortSignal;
  options: { settings: FamilySettings; settingsVersion: number; authorize: () => Promise<void> };
}
```

`job`은 가족·임대 식별자와 채널 페이로드를 유지한다. `payload.sentAt`은 전송 시각이며 `now`는 현행 처리 기준 시각이다. 반환 문자열은 기존 처리 결과다. 성공 커밋, 대기 질문과 응답의 원자적 기록은 각 Skill 실행 경로에서 한 번만 이뤄진다. `main.js`가 실패·작업 임대·발송·스케줄링을 계속 맡는다. 둘째 Skill의 실제 요구가 드러날 때 명시적 선택 규약과 의존성 범위를 추가한다.

### 컨텍스트 소유권과 후속 라우팅

- Calendar가 요청 본문, 후보 버전, 시간 기준, LangGraph 스냅샷 및 상세·버튼 의미를 소유한다. 첫 도입에서는 기존 `runtime` 값과 토큰을 그대로 읽고 쓴다. 이미 중단된 Calendar 질문도 동일한 어댑터로 전달된다.
- 둘째 Skill을 추가할 때 Core가 소유할 최소 라우팅 메타데이터는 `skillId`, `familyId`, `chatId`, `actor`, `requestId`, `expiresAt`이다. 명시적 봇 답장이나 버튼 참조는 유효한 소유 Skill을 우선 식별한다. 검증된 질문과 연결되는 짧은 응답은 해당 Skill에 전달한다. 명시적인 새 요청은 독립 라우팅 대상으로 처리하고, 서로 다른 Skill의 질문을 가리킬 수 있는 짧은 응답은 어느 질문인지 확인한다.
- 기존 `skillId` 없는 상태와 참조는 Calendar에 전달하고 기존 검증을 거친다. 두 번째 Skill 도입 시 새 메타데이터는 기존 `runtime` JSON과 발송 문맥에 선택 필드로 추가하는 방식이 가능하다. 메타데이터와 Skill 상태를 함께 저장하고, 실제 재개 권한과 토큰 소비는 Skill의 기존 커밋 경로에서 재확인한다. 분류기와 대화 내용을 중앙에 복제할 필요가 없다.

### 구현 순서와 파일 목록

| 단계 | 작업 및 파일 |
| --- | --- |
| 1 · 이번 작업 | 이 문서와 `test/tpa-core-regression.test.js`로 현재 동작 및 차이를 고정한다. |
| 2 · 첫 Core 도입 | 추가 `src/core/skill.js`에 최소 JSDoc 계약, `src/core/router.js`에 하나의 등록·디스패치 경로, `src/skills/calendar.js`에 `processJob` 위임 어댑터. 수정 `src/main.js`에서 인스턴스 조립과 worker 호출 한 지점. 추가 `test/core-dispatch.test.js`에서 인자 전달, 실패 전파와 기존 Calendar 동작을 검증한다. |
| 3 · 둘째 Skill 연결 시 | 수정 후보는 `src/core/router.js`, `src/core/skill.js`, `src/storage.js`, `src/main.js`, `src/processor.js`다. 각각 라우팅 우선순위, 채널 중립 메타데이터 계약, 상태와 발송 참조의 원자적 기록·복원, 조립, Calendar 메타데이터 연결을 담당한다. 콜백으로 새 Skill을 연결하는 요구가 생기면 `src/router.js`의 콜백 식별도 검토한다. |

첫 Core 단계에서 `src/router.js`, `src/processor.js`, `src/context.js`, `src/storage.js`, `src/assistant/*`, `src/natural.js`, 반복·일정 저장 모듈, SQL, 패키지 설정, `PRD.md`는 현행대로 사용한다. 배포 판단에는 기존 질문 복원, 응답·예약 큐와 권한 재확인, 전체 회귀 통과를 사용한다. Gmail, Google Calendar, Google Photos, Finance와 별도 Worker의 도입은 각각 기능 요구와 실행 특성이 확인되는 이후 단계의 작업이다.
