# mTLS

이 문서는 운영자를 위한 페이지입니다. aimer-web이 aimer 백엔드와
상호 TLS(mutual TLS)로 통신하도록 설정하는 종단 간 절차를
설명합니다. 인증서가 어떻게 발급되는지, aimer-web이 읽는 환경
변수는 무엇인지, 회전 후 핫 리로드를 어떻게 트리거하는지, 만료와
리로드 결과를 알리는 로그 라인이 무엇인지 다룹니다.

mTLS는 클라이언트 한쪽만의 기능이 **아닙니다**. aimer-web이
클라이언트이고, aimer 백엔드가 서버입니다. aimer-web 쪽 절차만
따라서는 채널을 올릴 수 없습니다. 서버 측 설정(`auth-mtls` Cargo
기능, 리스너 구성, aimer의 SIGHUP 동작)에 대해서는 aimer 운영자
문서를 참고하십시오. 해당 문서가 아직 공개되지 않았다면 작업은
엄브렐러 이슈
<https://github.com/aicers/aimer/issues/358> 에서 추적 중이며,
aimer의 SIGHUP 문서는
<https://github.com/aicers/aimer/issues/367> 을 통해 게시됩니다.

<!-- TODO(#231): aimer 운영자 페이지가 공개되면 위의 교차 저장소
엄브렐러 링크를 해당 페이지의 딥링크로 교체하십시오. -->

## 종단 간 설정 체크리스트

새 배포 환경에서 다음 단계를 위에서 아래로 따르십시오. 1–4단계는
파이프를 올리는 단계이고, 5단계는 배선이 올바른지 입증하는 교차
버전 스모크 테스트입니다.

1. **bootroot이 인증서 쌍을 발급합니다** (cert + key + CA).
   aimer-web 호스트와 aimer 호스트 양쪽에 모두 배치됩니다.
   aimer-web은 bootroot이 출력할 수 있는 세 가지 PEM 형식의
   비공개 키를 모두 받아들입니다 — PKCS#8
   (`-----BEGIN PRIVATE KEY-----`), PKCS#1 RSA
   (`-----BEGIN RSA PRIVATE KEY-----`), SEC1 EC
   (`-----BEGIN EC PRIVATE KEY-----`). 운영자가 형식을 변환할
   필요는 없으며, aimer-web이 내부적으로 PKCS#8로 정규화합니다.
   (향후 bootroot 형식이 변경될 때 참고할 수 있도록 명시해
   둡니다.)
2. **aimer를 `auth-mtls` Cargo 기능으로 빌드합니다.** 이는
   <https://github.com/aicers/aimer/issues/358> 에서 추적되는
   옵트인 서버 빌드입니다. 서버 측 리스너는 aimer 운영자 문서에
   따라 구성하십시오.
3. **aimer-web을 구성합니다.** 아래 "환경 변수" 섹션의 환경
   변수를 설정합니다. 동일한 인증서/키 쌍이 TLS 핸드셰이크와
   요청당 JWT 서명 모두에 사용됩니다 — 별도의 서명 키는
   없습니다.
4. **(선택 사항) 양쪽에 SIGHUP을 보내 리로드 경로를
   확인합니다.** aimer-web의 SIGHUP 핸들러는 부팅 시
   `src/instrumentation.ts`에 의해 자동 등록되며, 인증서는 첫
   요청에서 지연 로드되므로 이 단계는 최초 설정에 필수는 아니고
   리로드 경로의 동작을 검증하는 의미를 가집니다. 아래 "회전 후
   리로드" 섹션을 참고하십시오.
5. **교차 버전 스모크 테스트를 실행합니다.**
   <https://github.com/aicers/aimer-web/discussions/9> 의 검증
   항목 41에 해당합니다. `auth-mtls` aimer 빌드에 대해 mTLS로
   라우팅된 GraphQL 요청을 보내고, JWT 계약을 검증하십시오 —
   `aud = "aimer"`, `exp - iat = 300`, **`customer_ids` 클레임
   없음**. 이 단계는 살아 있는 `auth-mtls` aimer 빌드를
   요구하며,
   <https://github.com/aicers/aimer-web/issues/44> 의 기능 완성
   목표물의 일부입니다. 본 문서는 운영자 참고용으로 절차를
   기록할 뿐, 파이프 수용 조건은 아닙니다.

## 환경 변수

| 이름 | 필수 | 설명 | 기본값 |
| --- | --- | --- | --- |
| `MTLS_CERT_PATH` | 예 | bootroot이 발급한 클라이언트 인증서 PEM의 파일 경로. | _(미설정 시 aimer-web이 mTLS 상태 구축을 거부합니다)_ |
| `MTLS_KEY_PATH` | 예 | `MTLS_CERT_PATH`와 쌍을 이루는 비공개 키 PEM의 파일 경로. PKCS#8, PKCS#1 RSA, SEC1 EC 모두 허용. | _(미설정 시 aimer-web이 mTLS 상태 구축을 거부합니다)_ |
| `MTLS_CA_PATH` | 예 | aimer 서버 인증서를 검증할 CA 번들 PEM의 파일 경로. | _(미설정 시 aimer-web이 mTLS 상태 구축을 거부합니다)_ |
| `AIMER_GRAPHQL_ENDPOINT` | 예 | aimer GraphQL 엔드포인트 URL (예: `https://aimer.internal/graphql`). | _(미설정 시 mTLS로 라우팅된 클라이언트가 디스패치를 거부합니다)_ |

세 개의 `MTLS_*` 경로는 `src/lib/mtls.ts`가 첫 요청 시점에 (지연
초기화로) 읽고, SIGHUP마다 다시 읽습니다 — 인증서 파일을 회전하고
프로세스에 신호를 보내면 재시작 없이 새 값이 반영됩니다.

`AIMER_GRAPHQL_ENDPOINT`는 `src/lib/graphql/client.ts`가 매 디스패치
시점에 `process.env`에서 읽으며, SIGHUP 리로드 경로에 **포함되지
않습니다**. 서비스 환경 파일에서 엔드포인트를 변경한 경우에는
aimer-web 프로세스를 재시작해야 합니다 — 인증서 파일과 달리
SIGHUP으로는 반영되지 않습니다.

별도의 설정 파일은 없으며 환경 변수가 유일한 출처입니다.

동일한 인증서 쌍이 대화의 양쪽 다리를 구동합니다. TLS 핸드셰이크의
클라이언트 인증서이자, aimer-web이 요청마다 발급하는 JWT의 서명
키이기도 합니다. 한쪽을 회전하면 다른 쪽도 함께 회전됩니다.

### JWT 계약

aimer-web이 요청마다 서명하여 보내는 토큰의 클레임은 다음과
같습니다.

- `sub` — 호출한 사용자의 account id.
- `aice_id` — 호출과 연관된 AICE 식별자.
- `aud = "aimer"` — 코드에 고정. **설정 불가**.
- `exp = iat + 300` — 5분 고정 수명.
- `jti` — 요청마다 무작위 UUID.
- **`customer_ids` 클레임 없음.** 고객 권한 확인은 호출 전에
  aimer-web의 BFF 라우트 계층에서 수행되며, JWT 자체에는 들어가지
  않습니다. 환경 변수를 변경해도 이 계약은 영향을 받지 않습니다.

## 지원하는 인증서 알고리즘

aimer-web은 인증서의 공개 키에서 알고리즘을 감지하고, 그에 맞는
알고리즘으로 JWT를 서명합니다.

| 공개 키 | 알고리즘 |
| --- | --- |
| RSA, ≥ 4096-bit 모듈러스 | `RS512` |
| RSA, ≥ 3072-bit 모듈러스 | `RS384` |
| RSA, 더 작은 모듈러스 | `RS256` |
| EC, `prime256v1` (P-256) | `ES256` |
| EC, `secp384r1` (P-384) | `ES384` |

**ES512 (EC P-521)는 의도적으로 지원하지 않습니다.** bootroot이
P-521 클라이언트 인증서를 발급하도록 설정된 경우, aimer-web은
명확한 오류(`Unsupported EC curve: secp521r1`)와 함께 mTLS 상태
구축에 실패합니다. 코드에서 목록을 확장하기 전에 P-521 인증서를
배포하지 마십시오.

## 인증서 파일 배치 기대값

bootroot은 운영자가 선택한 경로에 세 개의 PEM 파일을 기록합니다.
아래 systemd / k8s 예시에서 사용하는 권장 배치는 다음과 같습니다.

| 파일 | 소유권 | 권한 | 용도 |
| --- | --- | --- | --- |
| `<dir>/client.crt` | `aimer-web:aimer-web` | `0644` | 클라이언트 인증서 (`MTLS_CERT_PATH`) |
| `<dir>/client.key` | `aimer-web:aimer-web` | `0600` | 비공개 키 (`MTLS_KEY_PATH`) |
| `<dir>/ca.crt` | `aimer-web:aimer-web` | `0644` | aimer 검증용 CA 번들 (`MTLS_CA_PATH`) |

비공개 키는 aimer-web 서비스 계정만 읽을 수 있어야 합니다.
인증서와 CA 번들은 누구나 읽을 수 있어도 됩니다. bootroot은 이
파일들을 in-place로 회전하지만 aimer-web은 파일시스템을 감시하지
않으므로, SIGHUP을 보내기 전까지 회전이 반영되지 않습니다(아래
참고).

## 회전 후 리로드

aimer-web은 부팅 시 `src/instrumentation.ts`를 통해 SIGHUP
핸들러를 설치합니다. 핸들러는
`src/lib/instrumentation/mtls-sighup.ts`에 등록되며,
`src/lib/mtls.ts`의 `reload()`를 호출합니다. `reload()`는 다음을
수행합니다.

- 동일한 환경 변수 경로에서 세 PEM 파일을 다시 읽고,
- 새 TLS 에이전트와 새 JWT 서명 키를 생성하고,
- 새 상태를 원자적으로 교체하고,
- 이전 에이전트를 은퇴 처리하여 마지막 진행 중 요청이 끝난 후
  드레인합니다.

교체 과정에서 다운타임은 없으며, 떨어지는 요청도 없습니다.

### 어떤 PID로 신호를 보낼지

bootroot은 **각 호스트**에서 파일을 회전하고, 각 Node 프로세스는
자체 인메모리 인증서 상태를 보유합니다. 트래픽을 처리하는 모든
Node 프로세스에 신호를 보내야 합니다 — 한 개만으로는 부족합니다.

- **베어 Node (`pnpm start` / `next start`):** 부모 `next`
  프로세스에 신호를 보냅니다. 예:
  `kill -HUP $(pgrep -f 'next start')`.
- **Next.js standalone 빌드 (`output: "standalone"`):** standalone
  번들 안의 `node server.js` 프로세스에 신호를 보냅니다.
- **컨테이너:** 컨테이너 내부의 PID 1에 신호를 보냅니다. 예:
  `kill -HUP 1` (또는 `docker kill -s HUP <container>` /
  `kubectl exec <pod> -- kill -HUP 1`).
- **Node cluster 모드 / pm2 cluster / 다중 레플리카:** **모든**
  워커와 **모든** 레플리카에 신호를 보내야 합니다. pm2 cluster
  모드에서는 `pm2 reload <app>`이 각 워커를 다시 신호로
  깨웁니다. 레플리카가 N개인 Kubernetes Deployment라면 모든
  파드를 순회하십시오.

### systemd

일반적인 유닛 구성:

```ini
[Service]
ExecStart=/usr/bin/node /opt/aimer-web/server.js
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGTERM
```

bootroot이 인증서를 회전한 다음, 회전 훅에서
`systemctl reload aimer-web`을 실행하도록 구성하십시오.

### Kubernetes

Kubernetes는 마운트된 Secret 또는 ConfigMap이 회전될 때
라이프사이클 훅을 발화하지 **않습니다** — `postStart`는 컨테이너
시작 시 한 번만 실행되고, `preStop`은 종료 시에 실행됩니다. 따라서
리로드는 새 인증서 파일을 감지하고 모든 파드에 신호를 보내는
별도의 메커니즘으로 구동해야 합니다.

지원되는 두 가지 방식:

1. **회전기가 구동하는 `kubectl exec` 루프** (가장 단순). bootroot이
   마운트된 Secret을 갱신한 후, 회전기 잡이 다음을 실행합니다:

   ```sh
   kubectl get pods -l app=aimer-web -o name \
     | xargs -I{} kubectl exec {} -- kill -HUP 1
   ```

   **모든** 파드를 순회해야 합니다 — 각 Node 프로세스는 자체
   인메모리 인증서 상태를 보유하기 때문입니다.

2. **파드 스펙 안의 사이드카 워처.** 작은 사이드카 컨테이너가 인증서
   볼륨을 공유하며 마운트된 파일을 `inotify`로 감시하거나 폴링하고,
   공유 프로세스 네임스페이스(`shareProcessNamespace: true`)를 통해
   메인 컨테이너의 PID 1에 `kill -HUP 1`을 실행합니다. 리로드 트리거를
   파드 안에 두기 때문에, 회전기 잡에 클러스터 전역의 `pods/exec`
   권한을 부여하지 않아도 됩니다.

어느 방식을 쓰든 Deployment의 모든 레플리카에 신호를 보내야 합니다 —
bootroot은 각 노드에서 파일을 회전하므로, 일부 파드만 리로드된 상태로
남으면 이전 인증서로 계속 서비스를 제공하는 파드가 생깁니다.

### aimer

서버 측에서 인증서를 회전하려면
<https://github.com/aicers/aimer/issues/367> 에 기록된 aimer
SIGHUP 절차를 따르십시오. aimer-web과 aimer는 독립적으로
리로드합니다. 한쪽만 회전하면 채널이 불일치 상태로 남습니다.

## 로그 형식

아래 문자열은 `src/lib/mtls.ts`와
`src/lib/instrumentation/mtls-sighup.ts`가 그대로 출력합니다.
이 문자열을 grep하는 알림 규칙은 정확히 일치해야 합니다.

### 만료 감시

aimer-web은 6시간마다, 그리고 매 리로드 시점마다 적재된
인증서의 만료를 점검합니다. 만료 3일 이내에는 핑거프린트당 24시간
당 최대 1회 경고 라인을 출력하고, 이미 만료된 경우에는 동일한
속도 제한 아래에서 오류 라인을 출력합니다.

- 경고 (만료 3일 이내):
  `[mtls] client certificate expires in <N> day(s) at <ISO-timestamp> (fingerprint <hex>)`
- 오류 (이미 만료):
  `[mtls] client certificate has EXPIRED at <ISO-timestamp> (fingerprint <hex>)`

aimer는 자체 만료 경고를 독립적으로 출력합니다. 운영자는 양쪽을
모두 감시해야 합니다 — 서버 쪽 만료 임박은 aimer-web 로그에
드러나지 않습니다.

### SIGHUP 리로드

매 신호 처리 후 SIGHUP 핸들러가 출력합니다.

- 성공: `[mtls] SIGHUP: reloaded mTLS materials`
- 실패: `[mtls] SIGHUP: reload failed <error>`

리로드가 실패하면 이전 상태가 그대로 남고, aimer-web은 다음 성공
리로드 또는 재시작 전까지 기존 인증서로 계속 서비스를 제공합니다.
