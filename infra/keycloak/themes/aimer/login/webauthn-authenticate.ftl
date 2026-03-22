<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>
    <#if section = "form">
        <h1 class="aimer-title">${msg("webauthn-login-title")}</h1>

        <div class="aimer-webauthn-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4"/>
                <circle cx="12" cy="16" r="1"/>
            </svg>
        </div>

        <p class="aimer-subtitle">
            ${msg("webauthn-login-request")}
        </p>

        <#if message?has_content && message.type = 'error'>
            <div class="aimer-alert">
                <svg class="aimer-alert-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>${kcSanitize(message.summary)?no_esc}</span>
            </div>
        </#if>

        <form id="webauth" action="${url.loginAction}" method="post">
            <input type="hidden" id="clientDataJSON" name="clientDataJSON"/>
            <input type="hidden" id="authenticatorData" name="authenticatorData"/>
            <input type="hidden" id="signature" name="signature"/>
            <input type="hidden" id="credentialId" name="credentialId"/>
            <input type="hidden" id="userHandle" name="userHandle"/>
            <input type="hidden" id="error" name="error"/>
        </form>

        <#if authenticators??>
            <script type="text/javascript">
                (function() {
                    var challenge = "${challenge}";
                    var rpId = "${rpId}";
                    var createTimeout = ${createTimeout};
                    var allowCredentials = [
                        <#list authenticators.authenticators as authenticator>
                            {
                                id: base64url.decode("${authenticator.credentialId}"),
                                type: "public-key"
                            }<#if authenticator?has_next>,</#if>
                        </#list>
                    ];

                    var publicKey = {
                        rpId: rpId,
                        challenge: base64url.decode(challenge),
                        allowCredentials: allowCredentials,
                        timeout: createTimeout
                    };

                    navigator.credentials.get({publicKey: publicKey})
                        .then(function(result) {
                            document.getElementById("clientDataJSON").value = base64url.encode(new Uint8Array(result.response.clientDataJSON));
                            document.getElementById("authenticatorData").value = base64url.encode(new Uint8Array(result.response.authenticatorData));
                            document.getElementById("signature").value = base64url.encode(new Uint8Array(result.response.signature));
                            document.getElementById("credentialId").value = result.id;
                            if (result.response.userHandle) {
                                document.getElementById("userHandle").value = base64url.encode(new Uint8Array(result.response.userHandle));
                            }
                            document.getElementById("webauth").submit();
                        })
                        .catch(function(err) {
                            document.getElementById("error").value = err;
                            document.getElementById("webauth").submit();
                        });
                })();
            </script>
        </#if>

        <div class="aimer-footer" style="margin-top: 24px;">
            <a href="${url.loginUrl}">${kcSanitize(msg("backToLogin"))?no_esc}</a>
        </div>
    </#if>
</@layout.registrationLayout>
