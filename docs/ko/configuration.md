# 설정

이 페이지에서는 Aimer Web을 설정하는 방법을 설명합니다.

## 환경 변수

aimer-web은 프로세스 환경 변수에서 설정값을 읽습니다. 아래 표는
현재 이 페이지가 문서화한 변수들을 나열합니다. 이후 이슈에서 같은
4열 형식(`이름 | 필수 | 설명 | 기본값`)으로 추가 섹션을
이어붙입니다.

| 이름 | 필수 | 설명 | 기본값 |
| --- | --- | --- | --- |
| `MTLS_CERT_PATH` | 예 | aimer 백엔드와의 mTLS에 사용할 클라이언트 인증서 PEM의 파일 경로. 이 인증서의 공개 키가 JWT 서명 알고리즘을 결정하며, 만료 감시기가 보고하는 핑거프린트와 만료 시점도 여기서 가져옵니다. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `MTLS_KEY_PATH` | 예 | `MTLS_CERT_PATH`와 쌍을 이루는 비공개 키 PEM의 파일 경로. 실제 JWT 서명 키는 이 파일이며, aimer-web은 모든 외부 호출의 JWT를 이 키로 서명합니다. PKCS#8, PKCS#1 RSA, SEC1 EC 모두 허용. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `MTLS_CA_PATH` | 예 | aimer 서버 인증서를 검증할 CA 번들 PEM의 파일 경로. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `AIMER_GRAPHQL_ENDPOINT` | 예 | aimer GraphQL 엔드포인트 URL (예: `https://aimer.internal/graphql`). 미설정 시 mTLS로 라우팅된 GraphQL 클라이언트는 디스패치를 거부합니다. | _(미설정)_ |
| `EXPECTED_ORIGIN` | 예 (프로덕션) | 배포된 BFF의 공개 정규 오리진. BFF는 보통 리버스 프록시 뒤에서 동작하며 Next.js는 forwarded 헤더에서 공개 오리진을 추론하지 못하므로 프로덕션에서는 반드시 설정해야 합니다. OIDC `redirect_uri`, 콜백/로그아웃 URL, 초대 링크, 절대 리다이렉트를 생성하고 CSRF 검사에서 `Origin` 헤더를 검증할 때 사용합니다. 끝의 슬래시는 허용되며 시작 시 정규화되어 제거됩니다. 경로·쿼리·해시가 포함되면 거부됩니다. 예: `https://aimer-web.example.com`. | _(미설정)_ |
| `KC_HOSTNAME` | 예 (프로덕션) | Keycloak이 OIDC URL(이슈어, `redirect_uri`, 비밀번호 재설정 링크, 계정 콘솔)을 생성할 때 사용하는 정규 공개 URL. 프로덕션 프로파일이 `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`를 강제하므로 Keycloak 26은 스킴이 포함된 전체 URL만 허용합니다(베어 호스트명은 거부됨). 리버스 프록시가 Keycloak을 서브패스에 마운트하는 경우에는 공개 경로 접미사를 포함시키며, 번들된 `nginx-prod`는 `/auth`에 마운트하므로 번들 프록시용 값은 `https://aimer-web.example.com/auth`입니다. 쿼리·끝 슬래시는 포함하지 마십시오. 프로덕션 compose 프로파일은 이 값이 없으면 기동을 거부합니다. BFF와 Keycloak이 동일한 공개 오리진(스킴+호스트+포트)을 사용하도록 `EXPECTED_ORIGIN`과 짝지어 설정하십시오. 예: `https://aimer-web.example.com/auth`(번들 프록시), `https://aimer-web.example.com`(Keycloak이 apex에 위치), `https://auth.aimer-web.example.com`(Keycloak 전용 호스트). | _(미설정)_ |
| `KC_HTTP_RELATIVE_PATH` | 아니오 | Keycloak 프로세스 자체가 수신하는 경로 접두사. 프로덕션 compose 헬스체크는 OIDC 디스커버리 엔드포인트를 탐색할 때 이 값을 이어붙이므로 Keycloak의 실제 마운트 지점과 일치해야 합니다. 리버스 프록시가 공개 접두사를 제거한 뒤 프록시하는 경우 기본값 `/`을 유지하십시오(번들된 `nginx-prod`는 `/auth/`를 제거하므로 Keycloak은 여전히 `/`로 받습니다). 프록시가 접두사를 종단 간 보존할 때에만 `/auth`(또는 다른 접두사)로 설정하십시오. 공개 경로는 여기가 아니라 `KC_HOSTNAME`에 들어갑니다. | `/` |
| `DATA_DIR` | 아니오 | next-app이 세션 JWT 서명 키 쌍(`${DATA_DIR}/keys/ec-private.pem` — PKCS8, `${DATA_DIR}/keys/ec-public.pem` — SPKI)을 읽고(개발 환경에서는 기록도) 보관하는 파일시스템 디렉터리. 개발 환경에서는 BFF가 최초 기동 시 키 쌍을 자동 생성합니다. 프로덕션에서는 두 파일 중 하나라도 없으면 BFF 기동이 거부되므로, next-app에 트래픽이 도달하기 전에 운영자가 ES256 PEM 쌍을 사전 생성하여 `${DATA_DIR}/keys/`에 시드해 두어야 합니다. 프로덕션 compose 프로파일은 이 값을 `/app/data`로 고정하고 동일 경로에 `next-app-data` 네임드 볼륨을 바인드합니다. 사전 생성 절차는 [세션 JWT 키 영속화](#세션-jwt-키-영속화)를 참고하십시오. | `./data` (프로덕션 compose: `/app/data`) |

## 프로덕션 배포 참고사항

### Keycloak 호스트명 및 리버스 프록시

프로덕션에서는 세 가지 설정이 함께 Keycloak이 OIDC 응답에 노출하는
정규 공개 URL을 결정합니다.

- `KC_HOSTNAME`은 Keycloak이 모든 사용자 대상 URL(이슈어,
  `redirect_uri`, 비밀번호 재설정 링크, 계정 콘솔)을 생성할 때
  사용하는 정규 공개 URL을 고정합니다. 스킴이 포함된 전체 URL이어야
  합니다 — `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`인 경우 Keycloak
  26은 베어 호스트명을 거부합니다. 프로덕션 compose 프로파일은 이
  값이 없으면 기동을 거부합니다. 리버스 프록시가 Keycloak을
  서브패스에 마운트하는 경우 공개 경로 접미사를 포함할 수 있으며,
  `KC_HOSTNAME`에 포함된 경로는 Keycloak이 발급하는 모든
  브라우저용 OIDC URL의 접두사로 사용됩니다. 프록시 레이아웃에
  맞춰 다음 형식 중 하나를 선택하십시오.
  - 번들 `nginx-prod`: nginx가 `/auth/`에 Keycloak을 노출하므로
    `https://aimer-web.example.com/auth`를 사용합니다.
  - Keycloak이 전용 호스트나 전용 프록시의 apex에 위치할 때:
    `https://auth.aimer-web.example.com`(경로 없음)을 사용합니다.
- `KC_HOSTNAME_STRICT`는 프로덕션 프로파일에서 `"true"`로
  강제되어 Keycloak이 들어오는 `Host` 헤더로부터 URL을 추론하지
  않습니다. 비정규 호스트명이나 포트포워딩으로 Keycloak에 접근한
  사용자에게 잘못된 호스트의 로그인 폼·리다이렉트·이메일 링크가
  노출되는 호스트명 드리프트 버그군이 차단됩니다.
- `KC_HTTP_RELATIVE_PATH`는 `KC_HOSTNAME`의 공개 경로와 별개로
  Keycloak 프로세스 자체가 수신하는 경로 접두사입니다. 리버스
  프록시가 공개 접두사를 제거한 뒤 프록시하는 경우 기본값 `/`을
  유지하십시오 — 번들된 `nginx-prod`는 `/auth/`를 제거하므로
  Keycloak은 여전히 `/`로 요청을 받습니다. 프록시가 접두사를
  종단 간 보존할 때에만 `/auth`(또는 다른 접두사)로 설정하십시오.
  프로덕션 compose 헬스체크는 이 값을 프로브 URL에 이어붙이므로
  Keycloak이 실제 서비스하는 경로와 일치해야 합니다.

번들된 `nginx-prod`는 TLS를 종단하고 `keycloak-prod:8080`로
HTTP를 프록시하므로, 프로덕션 프로파일은 `keycloak-prod`가 HTTP를
수신할 수 있도록 `KC_HTTP_ENABLED=true`를 설정합니다. 리버스
프록시는 클라이언트에는 여전히 HTTPS를 제공하고
`X-Forwarded-Proto=https`를 전달하므로, Keycloak이 발급하는 OIDC
URL은 `KC_HOSTNAME`의 `https://` 스킴을 그대로 유지합니다.

`KEYCLOAK_URL`은 별개의 설정입니다. BFF → Keycloak 서버 간
디스커버리 및 토큰 교환에 사용되는 URL로, 보통 클러스터 내부
주소입니다. 번들된 프로덕션 프로파일에서는
`http://keycloak-prod:8080` — 내부 compose 주소이며 경로 접미사
없음 — 을 권장합니다. 프로덕션 프로파일이 `KC_HTTP_RELATIVE_PATH=/`를
유지하기 때문입니다. `KC_HTTP_RELATIVE_PATH`를 변경한 경우
`KEYCLOAK_URL`의 경로 구성요소도 동일하게 맞춰야 합니다.
`KC_HOSTNAME`은 Keycloak이 자신의 공개 URL을 인식하는 값으로,
브라우저용 URL을 생성할 때 사용합니다. 두 값은 같은 렐름을
가리키지만 값이 같은 경우는 드뭅니다.

`KEYCLOAK_URL`을 공개 프록시 URL(`KC_HOSTNAME` 값)로 설정하지
마십시오. 프로덕션 프로파일이 강제하는
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`로 인해 Keycloak은 들어오는
`Host` 헤더와 `KC_HTTP_RELATIVE_PATH`로부터 백채널 URL을 해석합니다.
BFF가 공개 프록시 URL을 통해 디스커버리를 받아오면 응답이
_분리_됩니다 — 프런트채널 URL(`issuer`, `authorization_endpoint`)은
공개 `/auth` 접두사를 포함하지만 백채널 URL(`token_endpoint`,
`jwks_uri`)은 포함하지 않습니다. 그 결과 BFF가 인가 코드를
교환하는 POST 요청은 nginx가 `next-app`으로 라우팅하는 경로로
가게 되며, 로그인이 `token_exchange_failed`에서 실패합니다.
`KEYCLOAK_URL`을 내부 주소로 유지하면 이러한 분리 자체가
발생하지 않습니다.

`EXPECTED_ORIGIN`은 BFF의 정규 공개 오리진(스킴+호스트+포트)이며,
`KC_HOSTNAME`의 오리진 구성요소와 일치해야 BFF와 Keycloak이
일관된 URL을 발급합니다. `EXPECTED_ORIGIN`은 오리진 전용이라
경로·쿼리·해시는 거부되지만, `KC_HOSTNAME`은 프록시가 Keycloak을
마운트하는 공개 경로를 포함할 수 있습니다 — 번들된 `nginx-prod`
환경에서는 `EXPECTED_ORIGIN=https://aimer-web.example.com`과
`KC_HOSTNAME=https://aimer-web.example.com/auth`가 짝을 이룹니다.
프로덕션 프로파일에서 함께 강제되는
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`로, Keycloak은 백채널
전용 URL은 forwarded 헤더에서 계속 해석합니다. 리버스 프록시
뒤에서 동작하는 올바른 동작입니다.

### 세션 JWT 키 영속화

next-app은 `${DATA_DIR}/keys/ec-private.pem`(PKCS8 PEM)과
`${DATA_DIR}/keys/ec-public.pem`(SPKI PEM)에 저장된 ES256 키
쌍으로 모든 세션 쿠키를 서명합니다. 개발 환경에서는 최초 기동
시 키 쌍이 자동 생성됩니다. 프로덕션에서는 두 파일 중 하나라도
없으면 BFF 기동이 거부됩니다 — next-app에 트래픽이 도달하기
전에 키가 이미 `${DATA_DIR}/keys/`에 존재해야 합니다. 의도된
동작입니다: 프로덕션에서 무음 재생성이 일어나면 발급된 모든
세션 쿠키가 가장 나쁜 시점에 무효화되기 때문입니다.

프로덕션 compose 프로파일에서 `DATA_DIR`은 `/app/data`로
고정되고 `next-app-data` 네임드 볼륨에 바인드됩니다. Compose가
프로젝트명으로 실제 볼륨 이름을 스코핑하므로 디스크상으로는
`aimer-web_next-app-data` 같은 이름이 됩니다. 따라서
`docker compose --profile prod up -d --force-recreate next-app`
이후에도 키 쌍이 보존됩니다. 볼륨이 삭제되면 키가 다시 시드될
때까지 다음 프로덕션 기동이 실패합니다 — 자동 재생성은 되지
않습니다. 바인드 마운트를 선호하는 운영자는 임의의 호스트
경로를 `/app/data`에 마운트할 수 있습니다. 네임드 볼륨이 기본인
이유는 호스트 측 사전 설정을 생략할 수 있기 때문입니다.

#### 신규 배포용 키 사전 생성

키는 P-256 EC 쌍이어야 합니다: 비공개 키는 PKCS8 PEM, 공개 키는
SPKI PEM. 호스트에서 openssl로 생성합니다.

```sh
mkdir -p ./data/keys
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -out ./data/keys/ec-private.pem
openssl pkey -in ./data/keys/ec-private.pem -pubout \
  -out ./data/keys/ec-public.pem
```

그런 다음 next-app이 `/app/data/keys/`에서 찾을 수 있도록
compose가 관리하는 볼륨으로 시드합니다. 시드 단계를
`docker compose run`을 통해 실행하면 Compose가 프로젝트 스코프된
볼륨 이름을 자동으로 해석하므로, 호스트에서 정확한 이름을 알
필요가 없습니다. `openssl genpkey`는 비공개 키를 호스트 사용자
소유의 `0600` 모드로 생성하므로, 시드 컨테이너는 바인드 마운트를
읽을 수 있도록 root(`--user 0`)로 실행해야 하며, 다음 기동 시
`--user`가 `nextjs`로 되돌아간 뒤에도 next-app이 키를 읽을 수
있도록 런타임 사용자/그룹(UID 1001, GID 1001 — Dockerfile의
`nextjs:nodejs`)으로 `install`해야 합니다.

```sh
docker compose --profile prod run --rm --no-deps \
  -v "$PWD/data/keys:/src:ro" \
  --user 0 \
  --entrypoint sh next-app \
  -c '
    mkdir -p /app/data/keys &&
    install -o 1001 -g 1001 -m 600 /src/ec-private.pem /app/data/keys/ec-private.pem &&
    install -o 1001 -g 1001 -m 644 /src/ec-public.pem  /app/data/keys/ec-public.pem
  '
```

이후 `docker compose --profile prod up -d`가 정상적으로
기동합니다. 볼륨이 실수로 삭제되더라도 복구할 수 있도록 호스트
측 `./data/keys/` 디렉터리는 백업해 두십시오. 키를 교체하면
활성 세션이 모두 무효화됩니다.

### 마이그레이션 안내

이번 하드닝 이전에 시작된 배포는 `KC_HOSTNAME_STRICT=false`에
의존했고 `DATA_DIR` 볼륨을 보존하지 않았습니다. 업그레이드 전에
다음을 수행하십시오.

1. `.env`의 `KC_HOSTNAME`에 스킴과 프록시가 Keycloak을
   마운트하는 공개 경로를 포함한 정규 공개 URL을 설정합니다
   (번들 `nginx-prod`: `https://aimer-web.example.com/auth`;
   apex/전용 호스트: `https://aimer-web.example.com` 또는
   `https://auth.aimer-web.example.com`). 끝 슬래시는 없어야
   합니다. 프로덕션 프로파일은 이 값이 없으면 즉시 실패합니다.
2. 리버스 프록시가 `KC_HOSTNAME`과 일치하는 안정된 `Host` 헤더와
   `X-Forwarded-*` 헤더를 전달하는지 확인합니다(번들된
   `nginx-prod`는 둘 다 수행).
3. 최초 `up --force-recreate` 전에 기존 배포본의
   `${DATA_DIR}/keys/` 내용을 새 `next-app-data` 네임드 볼륨으로
   시드합니다. 그렇지 않으면 프로덕션에서 BFF가 기동을 거부합니다.
   위 사전 생성 섹션의 `docker compose run` 시드 레시피를 그대로
   사용하되, 바인드 마운트의 소스를 이전 배포본의
   `${DATA_DIR}/keys/`로 지정하십시오. 복원은 1회성 작업입니다 —
   일단 키가 네임드 볼륨에 있으면 이후 재생성은 키에 영향을 주지
   않습니다.
