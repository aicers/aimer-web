# Phase 2 수집

이 문서는 운영자를 위한 페이지입니다. aimer-web이 aice-web-next에
노출하는 세 개의 Phase 2 배치 수집 엔드포인트, 표준 응답 형식,
요청 크기 상한, 그리고 종단 간 연결 점검 절차를 설명합니다.

## 엔드포인트

| 엔드포인트 | 스키마 버전 | 본문 |
| --- | --- | --- |
| `POST /api/phase2/baseline/batch` | `phase2.baseline.v1` | 동일한 `baseline_version` 하의 `baseline_event` 행 1개 이상 |
| `POST /api/phase2/story/batch` | `phase2.story.v1` | `story` 행 1개 이상과 각 행의 `story_member` 행 |
| `POST /api/phase2/policy-run` | `phase2.policy_run.v1` | 정확히 1개의 `policy_run` 행과 그 `policy_event` 행 |

세 엔드포인트는 동일한 `multipart/form-data` 봉투 계약을
사용합니다(RFC 0002 §6.1). `context_token`, `events_envelope`,
`events_data` 세 파트로 구성됩니다. aimer-web은 공용 봉투 헬퍼로
서명과 신선도를 검증하고, 인증 DB의 재생 방지 저장소
(`phase2_consumed_jtis`)에 컨텍스트 토큰의 `jti`를 1회 소비한 후,
대상 고객 데이터베이스에 자연 키 기준 `ON CONFLICT DO NOTHING`으로
INSERT합니다.

## 응답 형식

RFC 0002 §6에 따라 성공 응답은 항상 다음 네 필드를 가집니다.

```json
{
  "accepted": 12,
  "duplicates_skipped": 0,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "550e8400-e29b-41d4-a716-446655440000"
}
```

- `accepted`는 이번 호출에서 실제로 삽입된 행 수입니다.
- `duplicates_skipped`는 자연 키 충돌
  (`baseline_version, event_key` / `story_id, story_version` /
  `run_id, event_key`)로 건너뛴 행 수입니다.
- `received_at`은 응답 생성 시점의 aimer-web 벽시계 값입니다.
- `context_jti`는 봉투의 컨텍스트 토큰 `jti`를 그대로 반환하므로
  aice-web-next가 아웃박스 행과 매칭할 수 있습니다.

`phase2.story.v1`에서는 `accepted` / `duplicates_skipped`가
**스토리** 수이며, 그 구성원 수가 아닙니다. 구성원 단위 카운트는
관측성을 위해 `phase2.ingest` 감사 행의 `details` JSONB에 기록됩니다.

`phase2.policy_run.v1`에서는 `accepted` / `duplicates_skipped`가
**policy_event** 행 수이고, 런 행의 신규/중복 여부는 감사
`details.runStatus`에 기록됩니다. 같은 `run_id`에 대해 다중 배치로
도착해도 `(run_id, event_key)` 제약이 행 단위로 보장되므로 최종
상태는 동일하게 수렴합니다.

## 오류 응답

공용 봉투 헬퍼의 의미적 코드는 RFC 0002 §6의 HTTP 상태로
매핑됩니다.

| HTTP | `code` | 발생 시점 |
| --- | --- | --- |
| 400 | `malformed_multipart` | 폼 파싱 실패 |
| 400 | `missing_context_token` | 파트 없음/빈 값 |
| 400 | `missing_events_envelope` | 파트 없음/빈 값 |
| 400 | `missing_events_data` | 파트 없음/빈 값 |
| 400 | `malformed_payload` | `events_data`가 JSON 객체가 아님 |
| 400 | `missing_external_key` | 페이로드 루트에 `external_key` 없음 |
| 400 | `schema_version_mismatch` | 봉투의 `schema_version`이 엔드포인트와 다름 |
| 400 | `payload_schema_invalid` | Zod 검증 실패 |
| 401 | `invalid_context_token` | 서명/신선도/클레임 오류 |
| 401 | `invalid_events_envelope` | 서명/payload_hash/클레임 오류 |
| 401 | `trust_registry_key_expired` | `expires_at` 경과 |
| 403 | `payload_customer_not_authorized` | `external_key`가 컨텍스트 토큰 범위 밖 |
| 403 | `envelope_payload_aice_id_mismatch` | `events_data.source_aice_id`가 봉투 `aice_id`와 다름 |
| 404 | `customer_not_found` | `external_key`로 고객 행을 찾을 수 없음 |
| 409 | `context_jti_replay` | 동일한 `jti`가 이미 소비됨 |
| 413 | `events_data_too_large` | `BRIDGE_MAX_PAYLOAD_BYTES` 초과 |
| 500 | `database_error` | 봉투 검증 이후 고객 DB INSERT 실패(예: FK 위반, 캐스트 실패). `phase2.ingest_failed` 감사 행이 기록되며, 컨텍스트 토큰 `jti`는 해제되지 않으므로 재시도하려면 새 토큰을 발급받아야 합니다. |

5xx 이외의 오류는 aice-web-next 관점에서 재시도 없이 즉시 4xx로
사용자에게 노출됩니다.

## 요청 크기 상한

봉투 검증기는 모든 암호화 작업 이전에 `events_data` 바이트 길이를
`BRIDGE_MAX_PAYLOAD_BYTES`와 비교합니다. 기본값은 50 MiB이며 환경
변수로 변경할 수 있습니다.

상한 값은 두 저장소 간에 일치시켜야 합니다.

- aimer-web은 요청 시점에 `BRIDGE_MAX_PAYLOAD_BYTES`를 읽습니다.
- aice-web-next는 동일 `run_id`를 공유하는 다중
  `phase2.policy_run.v1` 배치로 분할하여 초과 정책 실행 결과를
  전송해야 합니다(RFC 0002 §6).

aimer-web의 상한을 올린다면 aice-web-next의 발신 측 상한도 함께
조정하십시오. 내리는 경우 발신 측 분할 로직이 따라오지 않으면
413이 반환되기 시작합니다.

## 종단 간 연결 점검

새 고객/AICE 쌍을 구성할 때 다음을 확인하십시오.

1. **신뢰 레지스트리**: AICE 환경의 서명 키가 인증 DB
   `trust_registry`에 등록되어 있고 만료되지 않았는지
   (`SELECT kid, expires_at FROM trust_registry WHERE aice_id = …`).
2. **고객 매핑**: `customers.external_key`가 aice-web-next가
   `events_data.external_key`에 넣는 값과 정확히 일치하는지.
   불일치 시 `404 customer_not_found`로 표면화됩니다.
3. **고객 데이터베이스**: `customers.database_status = 'active'`인지.
   `provisioning`/`failed` 상태는 고객 DB가 준비되지 않았음을
   의미하며, 경로가 풀을 얻더라도 INSERT가 실패합니다.
4. **Phase 2 테이블**: 고객 DB에 마이그레이션 `0002`가 적용되어
   있는지(고객 DB에서 `SELECT version FROM _migrations`). 수집에
   필요한 다섯 테이블은 `baseline_event`, `story`, `story_member`,
   `policy_run`, `policy_event`입니다.
5. **JTI 재생 저장소**: 인증 DB에 마이그레이션 `0018`이 적용되어
   있고, 런타임 역할이 `INSERT`/`DELETE` 할 수 있는지.
   `aimer_auth`로 `SELECT 1 FROM phase2_consumed_jtis LIMIT 1`로
   확인합니다.
6. **프로브 배치 전송**: aice-web-next에서 이벤트 1개로 시험
   호출합니다. 200 응답에 `accepted: 1`, `duplicates_skipped: 0`이
   반환되어야 합니다. 동일 컨텍스트 토큰으로 두 번째 호출하면
   409 `context_jti_replay`가 반환됩니다. 새 컨텍스트 토큰으로
   동일 이벤트 키를 한 번 더 보내면 200에 `accepted: 0`,
   `duplicates_skipped: 1`이 반환됩니다.

## 감사

성공한 수집마다 감사 DB에 `phase2.ingest` 행 한 개가 기록됩니다.
고객 DB INSERT 단계에서 실패하면 대신 `phase2.ingest_failed` 행
한 개가 기록되며 `details.error`에 원본 오류 메시지가 포함됩니다.
봉투/검증 실패(공유 검증기가 던지는 `EnvelopeVerificationError`)는
`phase2.verification_failed` 행 한 개를 남기며, `details.code`와
헬퍼가 부착한 부가 필드(예: `externalKey`, 키 만료 메타데이터)가
같이 기록됩니다. `actor_id`는 컨텍스트 토큰 검증을 통과한 이후에
실패한 경우 토큰의 `sub`이고, 그 외에는 `unknown`입니다. `aice_id`
및 `correlation_id`는 검증기가 컨텍스트 토큰을 이미 수락한 시점에
실패한 경우에만 채워집니다.

상위 컬럼:

- `actor_id` — 검증된 컨텍스트 토큰의 `sub` 클레임.
- `aice_id` — 이벤트 봉투에서.
- `customer_id` — 해석된 고객 UUID.
- `correlation_id` — 컨텍스트 토큰 `jti`. 저장소 간 상관관계
  추적용.

`details` JSONB에는 `schemaVersion`, `accepted`,
`duplicatesSkipped`, `eventCountClaim`(봉투 값)과 엔드포인트별
필드가 포함됩니다.

- baseline: `baselineVersion`.
- story: `storiesAccepted`, `storiesDuplicates`,
  `membersAccepted`, `membersDuplicates`.
- policy-run: `runId`, `runStatus` (`"new"` 또는 `"duplicate"`).

## 변경 엔드포인트

위의 세 수집 엔드포인트에 더해, aimer-web은 이미 수집된 데이터를
DELETE하거나 교체하는 세 개의 Phase 2 변경 엔드포인트를
노출합니다. multipart 봉투 계약, 컨텍스트 토큰 검증, jti 재생
방지 저장소, 감사 카테고리는 수집 라우트와 동일합니다.

| 엔드포인트 | 스키마 버전 | 의미 |
| --- | --- | --- |
| `POST /api/phase2/withdraw` | `phase2.withdraw.v1` | 자연 키로 특정 행을 DELETE |
| `POST /api/phase2/refresh-window` | `phase2.refresh_window.v1` | `[from, to)` 구간을 원자적으로 교체 |
| `POST /api/phase2/backfill` | `phase2.backfill.v1` | refresh-window와 동일한 형식·의미. 감사 액션과 운영자 의도로만 구분 |

### Withdraw

페이로드는 비어 있지 않은 `withdrawals` 배열을 가지며, 각 항목은
`kind`로 구분합니다.

- `baseline_event` — `{ baseline_version, event_keys[] }`
- `story` — `{ story_id, story_version }`
- `policy_event` — `{ run_id, event_keys[] }`
- `policy_run` — `{ run_id }`

모든 DELETE는 단일 고객 트랜잭션에서 실행됩니다. 하나라도 실패하면
전체가 롤백되고 응답은 `500`입니다. 응답은 `withdrawn`과
`not_found`를 따로 보고하며, `not_found`는 이미 사라진 행에 대한
정보용이지 오류가 아닙니다. `policy_run` 삭제 시 `policy_event`
자식 행은 FK CASCADE로, `story` 삭제 시 `story_member` 자식 행도
자동으로 제거됩니다. 라우트는 자식 테이블에 명시적 DELETE를 보내지
않습니다.

Zod 스키마는 또한 `{ kind: "policy_run", run_id: R }`과 동일한
`run_id`를 가진 `{ kind: "policy_event", run_id: R, ... }`이
같은 페이로드에 함께 있는 경우 `400 payload_schema_invalid`로
거부합니다. 런의 FK cascade가 이미 `policy_event` 자식 행을
제거하므로, 명시적 `policy_event` 항목에 매겨지는 카운트는
처리 순서에 따라 달라집니다 — 런보다 먼저 처리되면 `withdrawn`,
cascade 이후라면 `not_found`. 이는 발신자 버그를 가리므로
스키마 레이어에서 거부합니다.

응답:

```json
{
  "withdrawn": 3,
  "not_found": 1,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Refresh-window 및 Backfill

두 엔드포인트는 반-개방 `[window.from, window.to)` 구간의 내용을
원자적으로 교체합니다. 와이어상 동일합니다. 페이로드 형식,
응답 형식, 윈도우별 advisory lock, DELETE 후 INSERT 의미가 모두
같습니다. 차이는 봉투의 `schema_version` 클레임과 성공 감사
액션(`phase2.refresh_window` vs `phase2.backfill`)뿐입니다.
aice-web-next가 Force Rebuild를 수행했다면 `refresh-window`를,
관리자 운영자가 트리거했다면 `backfill`을 사용합니다.

페이로드:

```json
{
  "external_key": "...",
  "window": { "kind": "baseline_event", "from": "...", "to": "..." },
  "baseline_version": "...",
  "events": [ /* baseline_event 행. phase2.baseline.v1과 같은 형식 */ ]
}
```

`story` 윈도우에는 `baseline_version` + `events` 대신 `stories`를
사용합니다(`baseline_version`은 필요 없음). Zod 스키마가 거부하는
경우:

- `kind: "analyst_curated"`인 스토리 — 큐레이션 스토리는 이
  엔드포인트로 절대 영향받지 않습니다(RFC 0002 §6).
- `event_time`(baseline) 또는 `time_window.start`(story)이
  `[from, to)`를 벗어나는 행 — 전송측 버그로 간주해 `400
  payload_schema_invalid`로 즉시 실패시킵니다.
- 페이로드 내부 자연 키 중복 — `(baseline_version, event_key)`,
  `(story_id, story_version)`,
  `(story_id, story_version, member_event_key)`가 동일한 항목.
- 비정규 형식의 숫자 문자열(`"01"`, `"010"` 등): `event_key`,
  `story_id`, `run_id`, member `event_key` 모두 정규형만 허용합니다.
  DB의 자연 키는 `numeric` / `bigint`이라서 `"01"`과 `"1"`이 같은
  행으로 충돌하므로, 두 형태를 모두 받으면 페이로드 내부 중복
  가드를 우회해 PK 위반(JTI 소비 후 `500`)이나 withdraw 응답의
  카운트 왜곡으로 이어집니다.
- `from >= to`인 `window`(폭이 0이거나 뒤집힌 구간): 빈 배열이면
  행 멤버십 가드가 발동하지 않아 JTI를 소비하고 잠금을 잡은 뒤
  아무것도 삭제하지 않고 `200`을 반환하게 됩니다. 정상 no-op과
  구분할 수 없고 사실상 전송측 버그이므로 스키마 단계에서
  거부합니다.

DELETE 필터:

- baseline: `baseline_version = $1 AND event_time >= $from AND event_time < $to`.
  같은 시간 윈도우의 다른 `baseline_version` 행은 보존됩니다.
- story: `kind = 'auto_correlated' AND time_window_start >= $from AND
  time_window_start < $to`. 시작 시각이 `from` 이전이고
  `time_window_end`가 윈도우 안으로 연장되는 스토리는 refresh에서
  제거되지 않습니다 — 스토리는 시작 시각에 할당되며 생산측
  Force Rebuild 계약을 그대로 반영합니다.

응답:

```json
{
  "accepted": 12,
  "duplicates_skipped": 0,
  "deleted": 7,
  "received_at": "2026-05-17T10:23:45.012Z",
  "context_jti": "..."
}
```

`duplicates_skipped`는 항상 `0`입니다(INSERT 전에 윈도우가
비워지기 때문). `deleted`는 직전 DELETE가 제거한 행 수의
정보값입니다. 같은 본문으로 backfill을 다시 실행하면 동일한 종료
상태로 수렴합니다(`accepted`는 새 이벤트/스토리 수, `deleted`는
이전 실행의 `accepted` 값).

### Advisory lock

Refresh-window와 backfill은
`phase2_window|<window_kind>|<external_key>|<from>|<to>` 키로
`pg_advisory_xact_lock(hashtextextended(..., 0))` (단일 bigint
형식)을 윈도우 단위로 획득합니다. 키의 kind 세그먼트는 윈도우의
것이지 작업의 것이 아닙니다. 같은 윈도우에 대한 refresh와
backfill은 서로 직렬화되며, 이는 올바름의 불변식입니다(둘 다 같은
행을 DELETE+INSERT). 감사 액션은 의도를 구분하고, lock은 윈도우를
구분합니다.

같은 시간 윈도우 안에서 서로 다른 `baseline_version` 값의
refresh는 disjoint 행을 건드리지만 여전히 lock으로 직렬화됩니다.
프로파일링에서 경합이 관찰되면 후속에서 lock 키에
`baseline_version`을 포함하도록 변경할 수 있습니다.

### Replay 및 DB 실패 의미

변경 엔드포인트는 수집 라우트의 replay 저장소와 검증 후 실패
의미를 공유합니다.

- 재생된 `context_jti`는 `409 context_jti_replay`를 반환하며 DB
  변경을 수행하지 않고 윈도우별 advisory lock도 획득하지
  않습니다(재생이 같은 윈도우의 다른 동시 refresh를 멈춰서는 안
  됨). `phase2.{withdraw,refresh_window,backfill}` 감사 행을
  남기지 않습니다.
- 고객 트랜잭션 내부의 DB 실패(예: 캐스트 오류, FK 위반)는
  `500 database_error`를 반환하고 `phase2.ingest_failed` 감사
  행을 남깁니다(액션 이름은 역사적 이유로 수집과 공유. v1에서는
  검증 후 모든 Phase 2 변경 실패를 대표). 소비된 `jti`는
  `phase2_consumed_jtis`에 그대로 남으며, 재시도는 새 토큰
  발급이 필요합니다.

### 감사 details

성공 경로 액션:

- `phase2.withdraw` — `details`에 `schemaVersion`, `withdrawn`,
  `notFound`, `kindsTouched[]`.
- `phase2.refresh_window`와 `phase2.backfill` — `details`에
  `schemaVersion`, `window`, `accepted`, `deleted`, 그리고
  `eventCountClaim`(봉투 값. 송·수신 카운트 정합용).

실패 경로 액션은 `phase2.verification_failed`와
`phase2.ingest_failed`를 재사용합니다. 라우트는 `targetType`으로
구분합니다(`phase2_withdraw`, `phase2_refresh_window`,
`phase2_backfill`).
