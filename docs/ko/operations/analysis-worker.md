# 분석 워커

분석 워커(`src/lib/instrumentation/analysis-job-worker.ts`)는
`periodic_report_state` 행을 `pending`에서 `ready`로 승격시킵니다. 행이
속한 버킷이 닫히고 settle 윈도우가 경과하면 승격이 일어납니다. 이 페이지는
커서 워터마크(RFC 0002 Phase 0.5 / issue #295)에 관련된 운영자용
환경 변수와 로그 신호를 설명합니다.

## 스토리 준비(readiness) 윈도우

워커는 `story_analysis_state` 행도 `pending`에서 `ready`로 승격시킵니다.
스토리는 정적 윈도우 동안 유휴 상태가 되거나
(`ANALYSIS_STORY_IDLE_MINUTES` 동안 새 멤버 없음) **또는** 첫 멤버 이후
최대 대기 시간이 경과하면(`ANALYSIS_STORY_MAX_WAIT_HOURS`) 둘 중 먼저
도달하는 시점에 ready가 됩니다.

| 변수 | 기본값 | 적용 조건 |
| --- | --- | --- |
| `ANALYSIS_STORY_IDLE_MINUTES` | `15` | 유휴 윈도우. `last_member_at`과 비교 — 이만큼 유휴 상태인 스토리가 ready가 됩니다. |
| `ANALYSIS_STORY_MAX_WAIT_HOURS` | `6` | 최대 대기 상한. `first_member_at`과 비교 — 계속 활동 중인 스토리도 첫 멤버 이후 이만큼 경과하면 ready가 됩니다. |

두 값 모두 틱 시점에 읽으므로(프로세스 재시작 불필요) 배포별로 분석
지연 시간을 단축하거나 늘릴 수 있습니다. 각 값은 양의 정수여야 하며,
`0`, 음수, 숫자가 아닌 값은 거부되고 기본값이 사용됩니다. 이 윈도우는
순수 성능 노브가 아니라 제품 정책상 settle 노브입니다 — 값을 낮추면
스토리가 settle을 마치기 전에 분석되므로 의미 있는 하한을 유지하세요.

## DAILY settle 윈도우

워커는 각 pending DAILY 행에 대해 고객 시간대 기준 버킷 종료 시점과
`NOW()`, 그리고 설정된 settle 윈도우를 비교합니다. DAILY는 두 개의
환경 변수가 있습니다:

| 변수 | 기본값 | 적용 조건 |
| --- | --- | --- |
| `ANALYSIS_SETTLE_HOURS_DAILY` | `3` | 기본값. 버킷 종료 시점을 커버하는 strict 커서 워터마크가 없을 때 적용됩니다. |
| `ANALYSIS_SETTLE_HOURS_DAILY_WITH_WATERMARK` | `1` | 단축값. `periodic_report_state.cursor_watermark`가 NULL이 아니고, `cursor_watermark_quality = 'strict'`이며, `cursor_watermark >= bucket_end`일 때 적용됩니다. |

soft 워터마크(`cursor_watermark_quality = 'soft'`)와 워터마크가
없는 경우 모두 기본값으로 폴백합니다. 스토리 지연 커밋이 존재하므로
soft 워터마크는 settle을 단축해서는 안 됩니다.

WEEKLY 및 MONTHLY는 Phase 0.5에서 워터마크를 소비하지 않습니다.
해당 워커 행은 후속 단계에서 출시됩니다. 워터마크 컬럼은 해당 행에도
계속 채워지므로 추후 SQL 한 줄 수정으로 predicate를 활성화할 수
있습니다.

## "Settle 단축" 로그 라인

단축-워터마크 분기로 승격된 모든 DAILY 승격(즉, 기본 윈도우가 아직
경과하지 않은 경우)은 `info` 레벨로 구조화된 로그 한 줄을
출력합니다:

```json
{
  "level": "info",
  "event": "analysis.daily_settle_shortened",
  "customer_id": "…",
  "period": "DAILY",
  "bucket_date": "2026-05-27",
  "tz": "Asia/Seoul",
  "cursor_watermark": "2026-05-28T01:00:00.000Z",
  "bucket_end_at": "2026-05-27T15:00:00.000Z"
}
```

기본 settle만으로도 어차피 승격되었을 DAILY 행에는 이 로그가
출력되지 않습니다(실제 단축이 일어나지 않은 경우). WEEKLY / MONTHLY
행은 이 이벤트를 출력하지 않습니다.

## 워터마크 복구

핫 경로는 Phase 2 인제스트 훅에서 워터마크를 기록합니다. 훅이 실패하면
`phase2.ingest` 감사 행의 `details` JSONB에 `cursorEventTime` /
`cursorQuality`가 함께 기록됩니다. reconcile 패스는 최근 24시간 윈도우
내의 감사 행을 스캔해서 워터마크를 forward-patch합니다. 감사 쓰기까지
실패한 경우, 핸들러는 커서 필드를 포함한 에러 로그를 남기고 200을
반환합니다 — 해당 JTI는 이미 소비되어 재시도하면 `409
context_jti_replay`가 됩니다. 동일 고객의 다음 envelope이 직접
워터마크를 진행시킵니다.

## 베이스라인 이벤트 자동 분석 (Tier-B 일일 상한)

워커는 **느슨한(loose) 베이스라인 이벤트** — 어떤 스토리에도 속하지 않는
이벤트(스토리 멤버는 스토리 단위로 분석됨) — 도 자동 분석합니다. 인제스트된
느슨한 이벤트는 보류(held) 상태의 `event_analysis_job` 행으로 시드되고,
이후 틱에서 이벤트별 TI/IOC 판정(`event_enrichment_state`)에 따라
분류됩니다:

- **Tier A** — 알려진 IOC 적중. 항상 분석되며 **상한 없음**.
- **Tier B** — `coverage_status = 'complete'` 하에서의 미적중. 고객의
  일일 예산 내에서만 분석되고, 초과분은 종료 상태 `budget_skipped`로
  기록됩니다(조회 가능, 재시도 없음).
- **보류(Held)** — 판정이 없거나 비확정적인 경우
  (`partial`/`unknown`/`stale`)에는 아직 분류하지 않습니다. 워커는 제한된
  `runEventEnrichment` 재확인 루프를 구동하며, 판정이 알려진 IOC 적중으로
  바뀌면 Tier A로 라우팅하고, 한도 소진 시에는 (메트릭과 함께) Tier B로
  폴백합니다 — 결코 조용히 `budget_skipped`로 처리하지 않습니다.

Tier-B 상한은 **시드 시점 예약(seed-time reservation)** 입니다:
`(customer, budget_day)`별 카운트는 `done`뿐 아니라 진행 중인
`queued`/`processing` 행도 포함하므로, 백로그가 상한을 넘겨 과다
인큐될 수 없습니다. 예산은 **고객 타임존 달력일**(`customers.timezone`)
기준으로 초기화됩니다. 큐에 쌓인 작업은 중립적 시간 순서(소스
`event_time`, 그다음 `received_at`)로 픽업되므로, 낮은 상한에서는 그날
**가장 이른** 이벤트가 예산을 차지합니다 — 송신자 필드 기반 재정렬은
없습니다.

자동 분석된 리프(leaf)가 저장되면 워커는 해당 이벤트가 속한 주기
리포트 버킷을 다시 더티(dirty) 처리합니다(베이스라인 인제스트 훅이
올리는 것과 동일한 더티 신호). 리프는 여러 틱에 걸쳐 비동기적으로
생성되며 — 보통 해당 버킷의 리포트가 이미 생성된 뒤입니다 — 따라서 이
재더티(re-dirty) 처리가 느슨한 이벤트를 다음 리포트 틱에서 리포트 이벤트
경로에 노출시키며, 그렇지 않으면 무관한 활동이 버킷을 다시 더티
처리할 때까지 보이지 않습니다. 한 틱 안에서 이벤트 디스패치가 리포트
디스패치보다 먼저 실행되므로, 이번 틱에 분석된 리프가 같은 틱에 리포트를
재생성할 수 있습니다.

상한은 세 단계(고객별 오버라이드 → 관리자 전역 → 환경 변수)로
해석됩니다:

| 단계 | 소스 |
| --- | --- |
| 고객별 오버라이드 | `customer_baseline_analysis_cap.daily_cap` 행 (없으면 오버라이드 없음) |
| 관리자 전역 | `system_settings.baseline_auto_analysis_daily_cap` |
| 환경 변수 폴백 | `BASELINE_AUTO_ANALYSIS_DAILY_CAP` |

| 변수 | 기본값 | 사용 시점 |
| --- | --- | --- |
| `BASELINE_AUTO_ANALYSIS_DAILY_CAP` | `0` | 환경 변수 단계 Tier-B 상한(세 번째 단계). `0`이면 Tier B 비활성화; Tier A는 상한 없이 유지. |
| `BASELINE_AUTO_ANALYSIS_TIER_A_ENABLED` | `true` | 인시던트 대응용 Tier-A 킬 스위치. `false`인 동안 알려진 IOC 이벤트는 보류됩니다(Tier B로 강등되지 않음). |
| `BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_ATTEMPTS` | `5` | 보류 이벤트 enrichment 재확인 시도 한도. |
| `BASELINE_AUTO_ANALYSIS_MAX_ENRICHMENT_AGE_MINUTES` | `60` | 보류 이벤트 enrichment 재확인 경과 시간 한도. |

결과 행에는 `event_analysis_result.origin = 'auto_baseline'`(수동 경로는
`'manual'` 유지)과 `requested_by = NULL`(휴먼 요청자 없음; 워커는 감사
액터로 귀속됨)이 기록됩니다. 워커는 비율 모니터링을 위해 구조화된
`analysis.baseline_auto.*` 로그 라인(`tier_a_analyzed`,
`tier_b_admitted`, `budget_skipped`, `coverage_holdfallback`,
`tier_a_disabled_held`)을 방출합니다.
