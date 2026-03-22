<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>
    <#if section = "form">
        <h1 class="aimer-title">${msg("emailForgotTitle")}</h1>

        <div class="aimer-info-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
        </div>

        <p class="aimer-subtitle">
            To reset your password, please contact your system administrator.
        </p>

        <div style="margin-top: 24px;">
            <a href="${url.loginUrl}" class="aimer-btn aimer-btn-primary" style="display: flex;">
                ${kcSanitize(msg("backToLogin"))?no_esc}
            </a>
        </div>
    </#if>
</@layout.registrationLayout>
