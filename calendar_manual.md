# TPA Google Calendar 운영 매뉴얼

TPA 프로젝트 루트에서 실행합니다. 캘린더 동기화 워커는 토비 봇 프로세스 안에서 실행됩니다.

## 1. 연동 상태 확인

```sh
./tpa status
./tpa calendar status
./tpa calendar help
```

토비 가족방에서도 `!구글 캘린더 동기화 상태 알려줘`로 요약을 확인할 수 있습니다.

| 항목 | 확인할 내용 |
| --- | --- |
| `mode` | 현재 동기화 모드 |
| `lastSuccess` | 마지막 동기화 주기가 성공한 시각. CLI에서 끝에 `Z`가 붙으면 UTC이므로 한국 시간은 9시간을 더합니다. |
| `error` | 최근 동기화 오류 코드. `null`이면 기록된 최근 오류가 없습니다. |
| `inbox` | Google에서 받은 대기·보류 항목의 사유별 건수. `initial_review`는 검토 및 수동 승인 대기입니다. |
| `outbox` | Google로 보내는 작업의 상태별 건수. `pending`은 대기, `sending`은 전송 중, `uncertain`은 결과 확인 중, `held`는 보류, `failed`는 실패입니다. |
| `conflicts` | 열린 동기화 충돌. 충돌 사유 `reason`과 대상 ID를 확인합니다. |

`lastSuccess`는 워커 전체의 상태입니다. 개별 일정의 반영 여부는 미리보기와 대상 캘린더에서 확인합니다.

## 2. 일정 미리보기와 ID 확인

```sh
./tpa calendar preview --since 2026-11-24 --private
```

`--since`를 원하는 기준일로 바꾸거나 생략합니다. 기준일은 한국 시간이며 일정 날짜와 반복 회차를 기준으로 필터링합니다. 조회 결과에 제목이 필요할 때 `--private`를 붙입니다. 제목과 승인값이 포함된 출력은 비공개로 다룹니다.

| 출력 위치 | 사용할 값 |
| --- | --- |
| `remote[]` | Google 이벤트의 `id`와 `approval`. `when`, `importMode`, `candidates`를 함께 확인합니다. |
| `remote[].candidates[]` | 기존 TPA 일정과 연결할 때 쓰는 TPA `id`와 `version`. |
| `local[]` | Google 연결이 없는 TPA 일정의 `kind`, `id`, `version`. 내보낼 때 세 값을 함께 사용합니다. |

`local`은 미연결 일정 목록입니다. 전송 대기 중인 일정도 연결이 만들어지기 전까지 여기에 남을 수 있습니다. Google 일정과 일치하는 TPA 일정은 `remote[].candidates`에 표시됩니다.

## 3. Google → TPA 가져오기 및 연결

1. `preview`의 `remote`에서 제목과 날짜를 확인하고 해당 항목의 `id`와 `approval`을 함께 복사합니다.
2. `inbound` 또는 `bidirectional` 모드에서 아래 명령 중 하나를 실행합니다. 대문자 자리표시자는 조회한 실제 값으로 바꿉니다.
3. 결과가 `applied`이면 TPA에서 일정을 확인합니다. `held`이면 반환된 `code`를 확인합니다.

```sh
# TPA에 새 일정 만들기
./tpa calendar import 'EVENT_ID' 'APPROVAL'

# Google 제목을 숨겨서 가져오기
./tpa calendar import 'EVENT_ID' 'APPROVAL' --private-title

# 같은 일정이 TPA에 이미 있을 때 기존 일정과 연결
./tpa calendar link 'EVENT_ID' 'APPROVAL' 'TPA_ID' 'VERSION'
```

`candidates`에 같은 일정이 있으면 날짜와 시간을 확인한 뒤 `link`를 사용합니다. `Preview changed. Run preview again`이 나오면 최신 `preview`에서 승인값을 다시 복사합니다. Google 이벤트가 수정되면 이전 승인값이 만료될 수 있습니다.

보류 사유를 확인하거나 이벤트 ID를 알고 있는 경우 아래처럼 조회합니다. `review`의 승인값은 가져오기 대상인 `initial_review` 항목에 사용합니다. 연결을 해제한 일정의 재연결 승인값은 `preview`에서 확인합니다.

```sh
./tpa calendar review --private
./tpa calendar review 'EVENT_ID' --private
```

초기 가져오기 검토 건(`initial_review`)을 빼고 나머지 수신 보류 일정의 제목만 보려면 아래 명령을 사용합니다. 100건 제한은 필터링한 결과에 적용됩니다.

```sh
./tpa calendar review --private --skip-initial
```

반복 일정이 `review_required`이면 실제 회차를 먼저 확인합니다. Google의 반복 회차를 읽기 전용으로 가져오려면 활성 반복 일정의 상위 이벤트 ID를 사용합니다.

```sh
./tpa calendar instances 'EVENT_ID' --since 2026-11-24 --until 2027-01-01
./tpa calendar import-read-only 'EVENT_ID' 'APPROVAL'
```

## 4. TPA → Google 내보내기

1. `bidirectional` 모드인지 확인합니다.
2. `preview --since YYYY-MM-DD --private`로 `local`에서 일정의 `kind`, `id`, `version`을 확인합니다.
3. Google Calendar에서 같은 일정이 이미 있는지 확인합니다. 미리보기에서 연결 후보가 확인되면 `link`를 사용합니다.
4. 내보낸 뒤 워커가 처리할 시간을 두고 Google Calendar에서 제목과 날짜를 확인합니다.

```sh
# 단건 일정
./tpa calendar export task 'TPA_ID' 'VERSION'

# 반복 일정 전체
./tpa calendar export series 'TPA_ID' 'VERSION'
```

`queued: true`는 명령이 대기열 등록 경로를 마쳤다는 응답입니다. 전송 완료는 Google Calendar에서 확인합니다. `Local preview changed`가 나오면 최신 버전을 다시 조회합니다. 연동 전에 저장된 일정은 자동 소급 전송되지 않으므로, 미연결 일정은 이 절차로 처리합니다.

## 5. 모드 변경

| 모드 | 동작 |
| --- | --- |
| `paused` | 캘린더 동기화를 일시 정지합니다. 토비 봇은 계속 실행됩니다. |
| `preview` | Google 이벤트를 받아 검토용으로 보류합니다. 초기 검토에 사용합니다. |
| `inbound` | Google → TPA 방향으로 동기화하고 수동 가져오기·연결을 허용합니다. |
| `bidirectional` | 양방향 동기화와 수동 내보내기를 허용합니다. |

아래 명령 중 원하는 모드 하나를 실행하고 `status`로 확인합니다.

```sh
./tpa calendar mode paused
./tpa calendar mode preview
./tpa calendar mode inbound
./tpa calendar mode bidirectional
```

최초 설정 시에는 캘린더 설정을 준비한 뒤 `./tpa calendar configure`로 연결을 등록합니다. 최초 모드는 `paused`입니다. 봇이 실행 중인 상태에서 `preview`로 바꿔 초기 조회를 마친 뒤 `inbound` 또는 `bidirectional`로 전환합니다. 기존 `initial_review` 항목은 모드를 전환해도 수동 검토 대상입니다.

`Finish the preview before changing modes`가 나오면 `preview` 모드에서 초기 조회와 수신 대기 처리가 끝난 뒤 다시 시도합니다. `Sync is running. Retry after the current cycle`이 나오면 현재 워커 주기가 끝난 뒤 명령을 다시 실행합니다.

## 6. 연결 해제와 가져오기 취소

먼저 승인값 없이 실행해 영향을 확인합니다. 두 명령 모두 Google 이벤트는 유지합니다.

```sh
./tpa calendar unlink 'EVENT_ID'
./tpa calendar undo-import 'EVENT_ID'
```

- `unlink`는 TPA 일정을 보존하고 연결을 끊습니다.
- `undo-import`는 연결을 끊고 Google에서 가져오며 생성한 TPA 일정도 취소합니다. 기존 TPA 일정에 연결한 경우에는 TPA 일정을 보존합니다.
- 결과의 `removesLocalCopy`, `requiresChangeConfirmation`, `blocked`를 확인합니다. 적용하려면 해당 명령이 반환한 `approval`을 마지막에 붙입니다. 가져온 뒤 TPA에서 변경한 내용도 함께 취소해야 할 때만 `undo-import` 명령 끝에 `--confirm-local-changes`를 붙입니다.
- 다시 연결하려면 `preview`에서 새 승인값을 확인합니다. TPA에 보존된 일정이 있으면 그 일정의 ID와 버전으로 `link`를 실행합니다.

## 7. 반영이 안 될 때

- **최근 성공 시간이 갱신되지 않음** — `./tpa status`로 봇 실행 여부와 `calendar status`의 모드를 확인합니다. 필요하면 `./tpa logs 80`으로 최근 로그를 확인합니다.
- **`401` 또는 `403`** — Google 인증과 캘린더 접근 권한을 확인합니다. 인증 오류로 모드가 `paused`로 바뀌었으면 인증을 고친 뒤 운영 모드로 복귀합니다.
- **Google 일정이 `initial_review`에 남음** — `preview`에서 ID·승인값을 확인해 가져오거나 기존 일정과 연결합니다.
- **TPA 일정이 계속 `local`에 남음** — `outbox`의 대기·보류·실패와 `conflicts`를 확인합니다. `policy`는 정책에 따른 보류이며, 예를 들어 삭제 동기화가 꺼져 있을 때 취소 작업이 보류될 수 있습니다.
- **미리보기에 일정이 없음** — `--since`를 빼고 확인합니다. 이미 연결된 일정이나 다른 항목의 연결 후보로 분류된 일정은 `local`에 따로 표시되지 않습니다.
