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
실패한 수집은 기록하지 않습니다(봉투/검증 실패는 헬퍼의 기존
패턴에 따라 자체 감사 행을 남깁니다).

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
