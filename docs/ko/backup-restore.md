# 백업 및 복원

이 문서는 Aimer Web의 모든 상태 저장 구성 요소를 백업하고
복원하는 방법을 다룹니다: 중앙 데이터베이스(`auth_db`, `audit_db`),
고객별 데이터베이스, 그리고 OpenBao 비밀 엔진.

## 사전 요구 사항

- **PostgreSQL 클라이언트 도구** (`pg_dump`, `pg_restore`)가
  `PATH`에 있어야 합니다. PostgreSQL 서버 버전과 동일하거나
  최신 버전이어야 합니다.
- **tar** — OpenBao 파일 저장소 백업에 필요합니다.
- 환경 변수가 설정되어 있어야 합니다
  (아래 [환경 변수](#환경-변수) 참조).

## 백업 대상

| 대상         | 백업 내용                                            |
| ------------ | ---------------------------------------------------- |
| `auth`       | 중앙 인증 데이터베이스 (`pg_dump --format=custom`)   |
| `audit`      | 중앙 감사 데이터베이스                               |
| `customers`  | `database_status`가 `IN ('active', 'failed')`인      |
|              | 모든 고객 데이터베이스                               |
| `openbao`    | OpenBao `file` 저장소 디렉토리 (KEK + DEK)           |

정지(suspended) 및 비활성화(disabled) 상태의 고객 데이터베이스도
`database_status`가 `active` 또는 `failed`이면 포함됩니다.
실제로 존재하지 않는 데이터베이스(프로비저닝 실패)는 경고와 함께
건너뜁니다.

## 백업 실행

```bash
# 모든 대상 전체 백업
pnpm backup --target=all

# 단일 대상 백업
pnpm backup --target=auth
pnpm backup --target=audit
pnpm backup --target=customers
pnpm backup --target=openbao

# 단일 고객 백업
pnpm backup --target=customers --customer-id=<uuid>

# 백업에 레이블 지정 (예: 파괴적 작업 전)
pnpm backup --target=customers --customer-id=<uuid> \
  --label=pre-delete-<uuid>

# 백업 디렉토리 재지정
pnpm backup --target=all --output-dir=/mnt/backups
```

### 백업 디렉토리 구조

각 백업은 타임스탬프가 포함된 디렉토리를 생성합니다:

    backups/
      2026-04-02T14-30-45Z/
        auth_db.dump
        audit_db.dump
        customers/
          customer_<uuid>.dump
        openbao/
          bao-data.tar.gz
        manifest.json

`manifest.json` 파일은 각 대상의 메타데이터(파일 경로, 크기,
소요 시간, 오류 또는 건너뛴 대상)를 기록합니다.

### 종료 코드

| 코드 | 의미                              |
| ---- | --------------------------------- |
| 0    | 모든 백업 성공                    |
| 1    | 하나 이상의 백업 실패             |
| 2    | 설정 오류 (누락된 플래그)         |

## 백업 스케줄링

백업 CLI는 외부 스케줄링(cron, systemd 타이머,
Kubernetes CronJob)을 위해 설계되었습니다.
매일 UTC 03:00에 백업하는 cron 예시:

    0 3 * * * cd /opt/aimer-web && pnpm backup --target=all >> /var/log/aimer-backup.log 2>&1

## 복원 절차

모든 복원 작업은 실수 방지를 위해 `--confirm` 플래그가
필요합니다. 먼저 `--dry-run`으로 검증할 수 있습니다.

### 전체 재해 복구

복원 순서: OpenBao -> auth_db -> audit_db -> customer_dbs ->
복원 후 정리 -> 마이그레이션 실행.

```bash
pnpm restore --target=full \
  --backup-dir=./backups/2026-04-02T14-30-45Z \
  --confirm
```

복원 후 자동 수행 작업 (건너뛰기 가능):

- 모든 세션 무효화
- 대기 중인 브릿지 연결 삭제
- 스테이징된 이벤트 데이터 삭제
- 마이그레이션 실행기가 백업 이후의 마이그레이션을 적용

복원 후 수동 작업:

1. Keycloak 재시작
2. OpenBao 봉인 해제
3. `pnpm migrate:customers`로 고객 DB 마이그레이션 실행
4. aimer-web 시작

### audit_db 단독 복구

`auth_db`가 정상인 상태에서 `audit_db`가 손상된 경우:

```bash
pnpm restore --target=audit \
  --backup-file=./backups/2026-04-02T14-30-45Z/audit_db.dump \
  --confirm
```

`audit_db`를 복원하고 마이그레이션을 실행합니다. `auth_db`는
변경하지 않습니다. 백업 시점과 장애 사이의 감사 항목은
손실됩니다.

### 단일 고객 복원

```bash
pnpm restore --target=customer \
  --customer-id=<uuid> \
  --backup-file=./backups/.../customers/customer_<uuid>.dump \
  --confirm
```

요구 사항:

- 고객의 래핑된 DEK가 OpenBao Transit에 존재해야 합니다
  (`pnpm backup:verify`로 확인).
- `auth_db`는 변경하지 않습니다 — 고객 레코드와 멤버십이
  유지됩니다.
- 이후 `pnpm migrate:customers --customer-id=<uuid>`를
  실행하세요.

### 하드 삭제 고객 복구 (예외적 상황)

고객이 하드 삭제된 경우(DEK 파기됨), `auth_db`와 `customer_db`
백업 및 OpenBao 백업에서 복구해야 합니다:

1. `auth_db` 백업을 임시 데이터베이스에 복원:

        pnpm restore --target=auth \
          --backup-file=./backups/.../auth_db.dump \
          --skip-post-cleanup --skip-migrations --confirm

2. 임시 데이터베이스에서 고객 행과 관련 레코드를 추출하여
   라이브 `auth_db`에 재삽입 (수동 SQL).

3. 백업에서 `customer_db` 복원:

        pnpm restore --target=customer \
          --customer-id=<uuid> \
          --backup-file=./backups/.../customers/customer_<uuid>.dump \
          --confirm

4. OpenBao 백업에서 DEK 복원:

        pnpm restore --target=openbao \
          --backup-file=./backups/.../openbao/bao-data.tar.gz \
          --confirm

5. OpenBao 봉인 해제 후 DEK 복호화 확인.

6. 고객 마이그레이션 실행:
   `pnpm migrate:customers --customer-id=<uuid>`

DEK 없이는 고객 데이터베이스 백업을 **복구할 수 없습니다**
(데이터가 저장 시 암호화되어 있음).

### OpenBao 복구

```bash
# 먼저 OpenBao를 중지하세요
pnpm restore --target=openbao \
  --backup-file=./backups/.../openbao/bao-data.tar.gz \
  --confirm
```

복원 후:

1. OpenBao 봉인 해제 (수동 Shamir 또는 자동 봉인 해제)
2. aimer-web 시작 전에 KEK 및 DEK 가용성 확인

### 잘못된 설정 복구

시스템 설정, 계정, 신뢰 레지스트리 잘못된 설정의 경우:
`auth_db`를 복원하지 **마세요**. 대신 감사 로그에서 이전 값을
확인하고 관리자 UI 또는 API로 수정하세요.

## 삭제 시 백업 아티팩트 처리

| 삭제 유형    | DEK 상태           | 백업 복구 가능 여부     |
| ------------ | ------------------ | ----------------------- |
| 하드 삭제    | 파기됨             | 백업 복호화 불가        |
| 복구 가능 삭제 | 백업에 보존됨    | 보존 기간 내 복구 가능  |

`audit_db` 백업은 보존 정책에 따라 정리됩니다.

## 보존 및 정리

매 백업 후 만료된 디렉토리가 자동으로 정리됩니다.
보존 기간은 환경 변수로 설정합니다:

- `BACKUP_RETENTION_DAYS` (기본값: 30) — auth_db 및 customer_db
- `AUDIT_BACKUP_RETENTION_DAYS` (기본값: 365) — audit_db

## 검증 드릴

백업이 복원 가능한지 정기적으로 검증하세요:

```bash
pnpm backup:verify --backup-dir=./backups/2026-04-02T14-30-45Z
```

드릴 절차:

1. 각 대상을 임시 데이터베이스에 복원
2. 마이그레이션 실행기 실행
3. OpenBao Transit을 통한 DEK 복호화 확인 (고객용)
4. 복원된 데이터베이스에서 데이터 읽기
5. 임시 데이터베이스 삭제

결과는 대상별로 PASS/FAIL로 출력됩니다. 검증이 하나라도
실패하면 종료 코드 1입니다.

## 환경 변수

| 변수                           | 필수   | 기본값       | 설명                                |
| ------------------------------ | ------ | ------------ | ----------------------------------- |
| `BACKUP_DIR`                   | 아니오 | `./backups`  | 백업 저장 루트 디렉토리             |
| `BACKUP_RETENTION_DAYS`        | 아니오 | `30`         | auth/customer 백업 보존 기간        |
| `AUDIT_BACKUP_RETENTION_DAYS`  | 아니오 | `365`        | audit 백업 보존 기간                |
| `BAO_DATA_DIR`                 | 예*    |              | OpenBao 파일 저장소 경로            |
| `BAO_ADDR`                     | 예     |              | OpenBao API 주소                    |
| `BAO_TOKEN`                    | 예     |              | OpenBao 인증 토큰                   |
| `DATABASE_MIGRATION_URL`       | 예     |              | auth_db 연결 (소유자 역할)          |
| `AUDIT_DATABASE_MIGRATION_URL` | 예     |              | audit_db 연결 (소유자 역할)         |
| `DATABASE_ADMIN_URL`           | 예     |              | DB 작업용 관리자 연결               |
| `CUSTOMER_DATABASE_OWNER_URL`  | 예     |              | 고객 DB 템플릿 (소유자 역할)        |

*OpenBao 백업/복원 대상에만 필요.

## 운영 환경 저장소

운영 환경에서 `BACKUP_DIR`은 암호화된 오프-호스트 저장소를
가리켜야 합니다 (예: 암호화된 NFS 마운트 또는 S3 기반 파일
시스템). 랜섬웨어 보호를 위해 Object Lock을 지원하는 객체
저장소(불변 백업 복사본)를 권장합니다.
