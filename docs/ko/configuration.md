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
