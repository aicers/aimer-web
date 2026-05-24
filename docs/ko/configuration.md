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
| `KC_HOSTNAME` | 예 (프로덕션) | Keycloak이 OIDC URL(이슈어, `redirect_uri`, 비밀번호 재설정 링크, 계정 콘솔)을 생성할 때 사용하는 정규 공개 호스트명. 스킴·경로·끝 슬래시 없이 호스트명만 입력합니다. 프로덕션 compose 프로파일은 이 값이 없으면 기동을 거부합니다. BFF와 Keycloak이 동일한 공개 URL을 사용하도록 `EXPECTED_ORIGIN`과 짝지어 설정하십시오. 예: `aimer-web.example.com`. | _(미설정)_ |
| `KC_HTTP_RELATIVE_PATH` | 아니오 | 리버스 프록시가 프록시 시 경로 접두사를 보존할 때 Keycloak이 마운트되는 경로 접두사. 프로덕션 compose 헬스체크는 OIDC 디스커버리 엔드포인트를 탐색할 때 이 값을 이어붙이므로 Keycloak의 실제 마운트 지점과 일치해야 합니다. 번들된 `nginx-prod`처럼 리버스 프록시가 접두사를 제거하는 경우 기본값 `/`을 유지하십시오. 접두사가 종단 간 보존될 때만 `/auth`(또는 다른 접두사)로 설정하십시오. | `/` |
| `DATA_DIR` | 아니오 | next-app이 생성된 상태를 저장하는 파일시스템 디렉터리. 가장 중요하게는 세션 JWT 서명 키 쌍(`${DATA_DIR}/keys/ec-private.pem`, `${DATA_DIR}/keys/ec-public.pem`)을 보관합니다. 이 키들은 컨테이너 재시작에도 반드시 보존되어야 하며, 재생성되면 발급된 모든 세션 쿠키가 무효화됩니다. 프로덕션 compose 프로파일은 이 값을 `/app/data`로 고정하고 동일 경로에 `next-app-data` 네임드 볼륨을 바인드합니다. 운영자가 관리하는 바인드 마운트도 동일 경로에 매핑하면 사용할 수 있습니다. 프로덕션에서는 키가 없으면 BFF가 기동을 거부하므로, 사전에 생성하거나 이전 배포본에서 복원해야 합니다. | `./data` (프로덕션 compose: `/app/data`) |

## 프로덕션 배포 참고사항

### Keycloak 호스트명 및 리버스 프록시

프로덕션에서는 세 가지 설정이 함께 Keycloak이 OIDC 응답에 노출하는
정규 공개 URL을 결정합니다.

- `KC_HOSTNAME`은 Keycloak이 모든 사용자 대상 URL(이슈어,
  `redirect_uri`, 비밀번호 재설정 링크, 계정 콘솔)을 생성할 때
  사용하는 호스트명을 고정합니다. 프로덕션 compose 프로파일은
  이 값이 없으면 기동을 거부합니다.
- `KC_HOSTNAME_STRICT`는 프로덕션 프로파일에서 `"true"`로
  강제되어 Keycloak이 들어오는 `Host` 헤더로부터 URL을 추론하지
  않습니다. 비정규 호스트명이나 포트포워딩으로 Keycloak에 접근한
  사용자에게 잘못된 호스트의 로그인 폼·리다이렉트·이메일 링크가
  노출되는 호스트명 드리프트 버그군이 차단됩니다.
- `KC_HTTP_RELATIVE_PATH`는 리버스 프록시가 보존하는 경로
  접두사와 일치시켜야 합니다. 프로덕션 compose 헬스체크에는
  기본값 `/`로 충분합니다. 리버스 프록시가 `/auth`(또는 다른
  접두사)를 Keycloak까지 종단 간 보존할 때만 그 값으로
  설정하십시오. 번들된 `nginx-prod`는 프록시 시 `/auth/`를
  제거하므로 `/`로도 헬스체크는 통과하지만, OIDC URL이 완전히
  올바르게 발급되려면 접두사를 보존하는 프록시가 필요합니다.

`KEYCLOAK_URL`은 별개의 설정입니다. BFF → Keycloak 서버 간
디스커버리 및 토큰 교환에 사용되는 URL로, 보통 클러스터 내부
주소입니다(예: `http://keycloak-prod:8080`). `KC_HOSTNAME`은
Keycloak이 자신의 공개 URL을 인식하는 값으로, 브라우저용 URL을
생성할 때 사용합니다. 두 값은 같은 렐름을 가리키지만 값이
같은 경우는 드뭅니다.

`EXPECTED_ORIGIN`(BFF 측의 `KC_HOSTNAME` 대응)은 `KC_HOSTNAME`과
일치해야 BFF와 Keycloak이 일관된 URL을 발급합니다. 프로덕션
프로파일에서 함께 강제되는 `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`로,
Keycloak은 백채널 전용 URL은 forwarded 헤더에서 계속 해석합니다.
리버스 프록시 뒤에서 동작하는 올바른 동작입니다.

### 세션 JWT 키 영속화

next-app은 최초 기동 시 세션 JWT 키 쌍을
`${DATA_DIR}/keys/ec-private.pem`,
`${DATA_DIR}/keys/ec-public.pem`에 기록합니다. 프로덕션에서
`DATA_DIR`은 `/app/data`로 고정되고 `next-app-data` 네임드
볼륨에 바인드되므로,
`docker compose --profile prod up -d --force-recreate next-app`
이후에도 키 쌍이 보존됩니다. 볼륨을 제거하면
(`docker volume rm next-app-data`) 키가 재생성되어 발급된 모든
세션 쿠키가 무효화됩니다. 바인드 마운트를 선호하는 운영자는
임의의 호스트 경로를 `/app/data`에 마운트할 수 있습니다.
네임드 볼륨이 기본인 이유는 호스트 측 사전 설정을 생략할 수
있기 때문입니다.

프로덕션에서는 키 파일이 없으면 BFF가 기동을 거부합니다 — next-app에
트래픽이 도달하기 전에 사전에 생성하거나 이전 배포본에서 복원해야
합니다.

### 마이그레이션 안내

이번 하드닝 이전에 시작된 배포는 `KC_HOSTNAME_STRICT=false`에
의존했고 `DATA_DIR` 볼륨을 보존하지 않았습니다. 업그레이드 전에
다음을 수행하십시오.

1. `.env`의 `KC_HOSTNAME`에 정규 공개 호스트명(스킴·끝 슬래시
   없이)을 설정합니다. 프로덕션 프로파일은 이 값이 없으면 즉시
   실패합니다.
2. 리버스 프록시가 `KC_HOSTNAME`과 일치하는 안정된 `Host` 헤더와
   `X-Forwarded-*` 헤더를 전달하는지 확인합니다(번들된
   `nginx-prod`는 둘 다 수행).
3. 최초 `up --force-recreate` 전에 기존 `${DATA_DIR}/keys/`
   내용을 새 `next-app-data` 네임드 볼륨으로 복사합니다.
   그렇지 않으면 프로덕션에서 BFF가 기동을 거부합니다. 네임드
   볼륨은 호스트에서 직접 쓸 수 없으므로 일회용 헬퍼 컨테이너로
   시드합니다(예: compose 프로젝트 디렉터리에서 실행):

   ```sh
   docker volume create next-app-data
   docker run --rm \
     -v next-app-data:/dst \
     -v "$PWD/data/keys:/src:ro" \
     alpine sh -c 'mkdir -p /dst/keys && cp -a /src/. /dst/keys/'
   ```

   복원은 1회성 작업입니다 — 일단 키가 네임드 볼륨에 있으면
   이후 재생성은 키에 영향을 주지 않습니다.
