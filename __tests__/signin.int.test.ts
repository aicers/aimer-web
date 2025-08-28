import { signInRequest } from "@/lib/graphql";

const endpoint = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT;
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;

if (!endpoint || !username || !password) {
  test.skip("signIn integration (env vars missing)", () => {});
} else {
  test("signIn returns JWT token (integration)", async () => {
    const res = await signInRequest({ username, password });
    expect(typeof res.token).toBe("string");
    expect(res.token.length).toBeGreaterThan(0);
  });
}
