# 보존 스위퍼

이 페이지는 운영자를 위한 문서입니다. 백그라운드 워커가 고객별
보존 정책에 따라 수집 및 분석 데이터를 삭제하는 방식을 설명합니다.
보존 기준은 `auth_db`의 `customer_retention_policy` 행에서 가져
옵니다.

스위퍼는 `src/instrumentation.ts`의 `register()`가 설치하는 단일
인프로세스 워커입니다. 별도의 운영자 UI는 없으며, 환경 변수와
감사 로그를 통해 제어됩니다.

## 보존이 적용되는 방식

각 틱은 `auth_db`에서
`customers × customer_retention_policy`를 읽고(필터:
`database_status = 'active'`), 활성 고객마다 공유 고객 런타임
풀(`src/lib/db/customer-runtime-pool.ts`, Phase 2 인제스트
쓰기에서도 사용됨)에서 전용 `PoolClient`를 빌려 해당 고객의
`customer_db`에
대해 트랜잭션 하나를 엽니다. 트랜잭션 내에서 스위퍼는:

1. 고객 UUID를 키로 하는 트랜잭션 범위 어드바이저리 락을 시도
   합니다. 락을 잡지 못하면(다른 레플리카가 이미 해당 고객을
   스윕 중) 워커는 롤백하고 다음 고객으로 진행합니다. 이때는 감사
   로그가 기록되지 않습니다.
2. `cutoff_ingestion = NOW() - ingestion_days`와
   `cutoff_analysis = NOW() - analysis_days`(분석 무제한이면 `NULL`)
   를 틱 시작 시점에 **한 번** 계산하고, 모든 `DELETE`에 동일한
   값을 사용합니다.
3. 각 테이블에서 기준을 초과한 행을 스윕합니다. `story_member`,
   `policy_event`는 부모의 `ON DELETE CASCADE`로 함께 삭제되며,
   동시 수집과 경쟁할 때도 감사 수치를 정확히 유지하기 위해
   부모 행을 `FOR UPDATE`로 잠근 뒤 자식 수를 세고 그다음에 부모
   를 삭제합니다.
4. `event_redaction_map` 캐스케이드를 수행합니다. 네 개의
   redacted-referent 테이블(`detection_events`, `baseline_event`,
   `story_member`, `policy_event`) **모두** 그리고
   `event_analysis_result`에 같은 `(aice_id, event_key)`를 가진
   행이 더 이상 없을 때에만 맵 행이 삭제됩니다. 이 참조 존재
   판정과 `(aice_id, event_key)` 잠금 순서는
   `src/lib/redaction/cascade.ts`에서 정의되므로, 이 스윕과
   향후 추가될 회고적 재비식별 스캔(#253)이 조인 형태에서
   어긋나지 않습니다.

어느 단계에서든 예외가 발생하면 해당 고객의 트랜잭션 전체가
롤백되며, 다음 틱에서 동일한 고객을 처음부터 다시 실행합니다.
삭제는 멱등이므로 롤백된 틱은 다음 틱에서 자연스럽게 수렴합니다.

## 그룹 리포트 보존

고객 **그룹**은 둘 이상의 멤버 고객을 모아, 생성된 리포트만 담는
전용 데이터 DB를 가집니다. 고객을 스윕하는 바로 그 틱이 보존 한도를
넘긴 **과거 기간**(DAILY/WEEKLY/MONTHLY) 그룹 리포트도 함께
수거(reap)하므로, 살아남은 모든 과거 그룹 리포트는 항상 완전히
역비식별 가능합니다.

**순서.** 그룹 수거는 각 틱의 **시작 시점**, 즉 고객별
`event_redaction_map` 스윕보다 **먼저** 실행됩니다. 이로써 살아남은
그룹 리포트가 같은 틱에서 멤버가 막 삭제하려는 비식별화 맵을
참조하는 일이 없도록 보장합니다.

**보존 한도.** 날짜 `D` 버킷의 그룹 리포트는
`D + min(coalesce(group_policy_days, ∞), min_over_members(H_c))`까지
보존됩니다. 여기서:

- `group_policy_days`는 그룹 자신의 분석 보존 기간으로,
  `group_retention_policy.analysis_days`(auth DB)에서 옵니다. `NULL`은
  *무제한*을 의미하며 — 해당 항이 `min`에서 빠집니다.
- 각 멤버의 `H_c = max(ingestion_days, coalesce(analysis_days, ∞))`는
  멤버의 `customer_retention_policy` 행(auth DB)에서 계산합니다.
  `analysis_days = NULL`인 멤버는 무제한(`H_c = ∞`)이라 `min`에서
  빠집니다.

그룹 정책과 모든 멤버가 무제한이면 리포트는 결코 수거되지 않습니다.
모든 한도 입력값은 **auth DB**에서 읽으며 — 수거기는 멤버 DB를 절대
열지 않으므로, 정지된 멤버라도 `H_c`는 계속 계산 가능합니다.

수거는 **버킷 날짜** `D`를 기준으로 시계를 맞추며(고객 스윕의 행
기입 시점 기준과는 의도적으로 다릅니다), 한도를 넘긴 행을
**삭제**합니다 — 저하된 표시로 남기는 폴백은 없습니다.
`customer_groups.database_status = 'active'`인 그룹만 처리하며,
`provisioning` / `failed` 그룹은 연결 시도 없이 건너뜁니다.

**LIVE는 버킷 날짜로 수거되지 않습니다.** LIVE는 합성
`bucket_date = '1970-01-01'`에 저장되는 단일 롤링 "현재" 버킷이며,
수거기는 `period <> 'LIVE'`로 필터링합니다. LIVE의 역비식별성은 이
보존 한도가 아니라 재생성 주기로 유지됩니다. (가장 짧은 멤버 보존
기간보다 오래 재생성이 멈춘 LIVE 결과를 강화하는 작업은 별도
후속 이슈로 미룹니다.)

**멤버 정책 누락.** 멤버 중 하나라도 `customer_retention_policy`
행이 없으면, 불완전한 한도 정보로 수거하지 않고 해당 틱에서 그룹을
**건너뜁니다**(`retention_sweep.group_skipped`로 감사). 멤버를
`min`에서 빼면 그룹 보존이 잘못 *연장*되기 때문입니다. 다음 틱 전에
누락된 정책을 조사하십시오.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` (1시간) | 틱 간격(ms). 최악의 보존 드리프트를 약 1 틱으로 한정합니다. 개발/QA 환경에서는 낮추고, DB 부하를 평탄화해야 할 때만 높이세요. 프로덕션에서는 수 분 미만으로 두지 마십시오. |

보존 기준 자체는 환경 변수로 설정하지 않고
`customer_retention_policy`에 고객별로 저장됩니다 (#252).

## 감사 이벤트

고객 DB 락을 잡은 모든 틱은 스윕 쿼리가 실행되기 **전에**
`retention_sweep.tick_started`를 기록합니다.
`retention_sweep.tick_completed`는 **한 건이라도 삭제가 발생한 경우에만**
기록됩니다. 아무것도 삭제되지 않은 틱은 의도적으로 기록하지
않아 감사 로그의 신호 밀도를 유지합니다. 어떤 형태의 실패든
`retention_sweep.tick_failed`가 기록됩니다. 여기에는 트랜잭션이
시작되기 *전*의 실패 — 고객 DB 연결 실패, `BEGIN` 실패, 자문
락 쿼리 실패 — 까지 포함됩니다. 운영자는 표준 에러 출력이 아니라
감사 로그에서 실패를 확인할 수 있어야 하기 때문입니다. 정책 누락
인바리언트(아래 참조)도 동일하게 `tick_failed` 행을 만듭니다.
세 이벤트는 모두 감사 로그 뷰어에서 확인할 수
있습니다([감사 로그](../audit-logs.md)).

`tick_completed.details.deleted_by_table`에는 테이블별 행 수가
담깁니다. `story_member`, `policy_event` 수치는 부모를 `FOR UPDATE`
로 잠근 상태에서 측정한 값이며, 부모 `DELETE`의 `rowCount`가 아닌
실제 캐스케이드로 삭제될 자식 행 수를 의미합니다.

그룹 수거는 자체 이벤트를 기록합니다. 과거 리포트 행이 하나라도
삭제되면 `retention_sweep.group_reaped`(상세에 `bound_days`,
`cutoff_bucket_date`, 삭제 행 수 포함), 멤버 정책 누락으로 그룹을
건너뛰면 `retention_sweep.group_skipped`, 그룹 데이터 DB에 연결할 수
없거나 삭제가 실패하면 `retention_sweep.group_failed`를 기록합니다.

## 정책 누락 인바리언트

활성 고객은 반드시 `customer_retention_policy` 행을 가져야 합니다.
프로비저닝 시 행을 삽입하며, 마이그레이션
`0023_backfill_customer_retention_policy.sql`이 테이블 이전에 만들
어진 고객을 백필합니다. 그럼에도 스위퍼가 정책 행이 없는 활성
고객을 만나면, `retention_sweep.tick_failed`를
`error_message = 'missing_retention_policy'`로 기록하고 해당 고객을
건너뜁니다. 이 경우 고객 DB는 **열리지 않으며**, 부분 삭제도
일어나지 않습니다. 다음 틱 전에 누락된 정책 행을 조사하십시오.

## 이 워커가 제어하지 않는 항목

- **수집 시 행 단위 비식별화**(이벤트에 찍힌 redaction policy
  버전) — `src/lib/redaction/` 참조.
- **정책이 좁아진 경우의 회고적 재비식별화** — 별도 잡(#253) 담당.
- **고객 보존 정책 편집 UI** — #252 담당. 워커는 매 틱마다
  `customer_retention_policy`를 다시 읽으므로 정책 변경은 별도
  "기존 데이터에 적용" 작업 없이 다음 틱부터 반영됩니다.
