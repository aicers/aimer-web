# 설정

이 페이지에서는 Aimer Web을 설정하는 방법을 설명합니다.

## 환경 변수

aimer-web은 프로세스 환경 변수에서 설정값을 읽습니다. 아래 표는
현재 이 페이지가 문서화한 변수들을 나열합니다. 이후 이슈에서 같은
4열 형식(`이름 | 필수 | 설명 | 기본값`)으로 추가 섹션을
이어붙입니다.

| 이름 | 필수 | 설명 | 기본값 |
| --- | --- | --- | --- |
| `MTLS_CERT_PATH` | 예 | aimer 백엔드와의 mTLS에 사용할 클라이언트 인증서 PEM의 파일 경로. JWT 서명 키의 출처이기도 합니다. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `MTLS_KEY_PATH` | 예 | `MTLS_CERT_PATH`와 쌍을 이루는 비공개 키 PEM의 파일 경로. PKCS#8, PKCS#1 RSA, SEC1 EC 모두 허용. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `MTLS_CA_PATH` | 예 | aimer 서버 인증서를 검증할 CA 번들 PEM의 파일 경로. [mTLS](operations/mtls.md) 페이지를 참고하십시오. | _(미설정)_ |
| `AIMER_GRAPHQL_ENDPOINT` | 예 | aimer GraphQL 엔드포인트 URL (예: `https://aimer.internal/graphql`). 미설정 시 mTLS로 라우팅된 GraphQL 클라이언트는 디스패치를 거부합니다. | _(미설정)_ |
