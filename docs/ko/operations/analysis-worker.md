# 분석 워커

분석 워커(`src/lib/instrumentation/analysis-job-worker.ts`)는
`periodic_report_state` 행을 `pending`에서 `ready`로 승격시킵니다. 행이
속한 버킷이 닫히고 settle 윈도우가 경과하면 승격이 일어납니다. 이 페이지는
커서 워터마크(RFC 0002 Phase 0.5 / issue #295)에 관련된 운영자용
환경 변수와 로그 신호를 설명합니다.

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
