<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false displayInfo=true; section>
    <#if section = "form">
        <div class="aimer-info-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
        </div>

        <#if message?has_content>
            <#if message.type = 'error'>
                <div class="aimer-alert">
                    <span>${kcSanitize(message.summary)?no_esc}</span>
                </div>
            <#else>
                <p class="aimer-subtitle">${kcSanitize(message.summary)?no_esc}</p>
            </#if>
        </#if>
    </#if>
    <#if section = "info">
        <#if requiredActions??>
            <p class="aimer-subtitle">
                <#list requiredActions as reqActionItem>${kcSanitize(msg("requiredAction.${reqActionItem}"))?no_esc}<#sep>, </#list>
            </p>
        </#if>

        <#if skipLink??>
        <#else>
            <#if pageRedirectUri?has_content>
                <div style="margin-top: 24px;">
                    <a href="${pageRedirectUri}" class="aimer-btn aimer-btn-primary" style="display: flex;">
                        ${kcSanitize(msg("backToApplication"))?no_esc}
                    </a>
                </div>
            <#elseif actionUri?has_content>
                <div style="margin-top: 24px;">
                    <a href="${actionUri}" class="aimer-btn aimer-btn-primary" style="display: flex;">
                        ${kcSanitize(msg("proceedWithAction"))?no_esc}
                    </a>
                </div>
            <#elseif (client.baseUrl)?has_content>
                <div style="margin-top: 24px;">
                    <a href="${client.baseUrl}" class="aimer-btn aimer-btn-primary" style="display: flex;">
                        ${kcSanitize(msg("backToApplication"))?no_esc}
                    </a>
                </div>
            </#if>
        </#if>
    </#if>
</@layout.registrationLayout>
