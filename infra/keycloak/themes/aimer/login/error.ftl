<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "form">
        <h1 class="aimer-title">${kcSanitize(msg("errorTitle"))?no_esc}</h1>

        <div class="aimer-alert">
            <svg class="aimer-alert-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>
                <#if message?has_content>
                    ${kcSanitize(message.summary)?no_esc}
                <#else>
                    ${kcSanitize(msg("errorGeneric"))?no_esc}
                </#if>
            </span>
        </div>

        <#if skipLink?? && skipLink>
        <#else>
            <#if client?? && client.baseUrl?has_content>
                <div style="margin-top: 24px;">
                    <a href="${client.baseUrl}" class="aimer-btn aimer-btn-primary" style="display: flex;">
                        ${kcSanitize(msg("backToApplication"))?no_esc}
                    </a>
                </div>
            </#if>
        </#if>
    </#if>
</@layout.registrationLayout>
