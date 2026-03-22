<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
    <#if section = "form">
        <h1 class="aimer-title">${msg("loginTotpTitle")}</h1>
        <p class="aimer-subtitle">${msg("loginTotpIntro")}</p>

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

        <form id="kc-otp-login-form" action="${url.loginAction}" method="post">
            <div class="aimer-form-group">
                <label for="otp" class="aimer-label">${msg("loginTotpOneTime")}</label>
                <input id="otp" name="otp" type="text"
                       class="aimer-otp-input<#if messagesPerField.existsError('totp')> has-error</#if>"
                       inputmode="numeric" pattern="[0-9]*"
                       autocomplete="one-time-code"
                       autofocus />
            </div>

            <input type="submit" class="aimer-btn aimer-btn-primary"
                   value="${msg("doLogIn")}" />
        </form>
    </#if>
</@layout.registrationLayout>
