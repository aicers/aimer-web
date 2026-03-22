<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('firstName','lastName','email','username','password','password-confirm'); section>
    <#if section = "form">
        <h1 class="aimer-title">${msg("registerTitle")}</h1>

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

        <form id="kc-register-form" action="${url.registrationAction}" method="post">
            <div class="aimer-form-group">
                <label for="firstName" class="aimer-label">${msg("firstName")}</label>
                <input id="firstName" name="firstName" type="text"
                       class="aimer-input<#if messagesPerField.existsError('firstName')> has-error</#if>"
                       value="${(register.formData.firstName!'')}"
                       placeholder="${msg("firstName")}" />
                <#if messagesPerField.existsError('firstName')>
                    <div class="aimer-error">
                        <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('firstName'))?no_esc}</span>
                    </div>
                </#if>
            </div>

            <div class="aimer-form-group">
                <label for="lastName" class="aimer-label">${msg("lastName")}</label>
                <input id="lastName" name="lastName" type="text"
                       class="aimer-input<#if messagesPerField.existsError('lastName')> has-error</#if>"
                       value="${(register.formData.lastName!'')}"
                       placeholder="${msg("lastName")}" />
                <#if messagesPerField.existsError('lastName')>
                    <div class="aimer-error">
                        <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('lastName'))?no_esc}</span>
                    </div>
                </#if>
            </div>

            <div class="aimer-form-group">
                <label for="email" class="aimer-label">${msg("email")}</label>
                <input id="email" name="email" type="email"
                       class="aimer-input<#if messagesPerField.existsError('email')> has-error</#if>"
                       value="${(register.formData.email!'')}"
                       placeholder="${msg("email")}"
                       autocomplete="email" />
                <#if messagesPerField.existsError('email')>
                    <div class="aimer-error">
                        <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('email'))?no_esc}</span>
                    </div>
                </#if>
            </div>

            <#if !realm.registrationEmailAsUsername>
                <div class="aimer-form-group">
                    <label for="username" class="aimer-label">${msg("username")}</label>
                    <input id="username" name="username" type="text"
                           class="aimer-input<#if messagesPerField.existsError('username')> has-error</#if>"
                           value="${(register.formData.username!'')}"
                           placeholder="${msg("username")}"
                           autocomplete="username" />
                    <#if messagesPerField.existsError('username')>
                        <div class="aimer-error">
                            <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                                 fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="8" x2="12" y2="12"/>
                                <line x1="12" y1="16" x2="12.01" y2="16"/>
                            </svg>
                            <span>${kcSanitize(messagesPerField.getFirstError('username'))?no_esc}</span>
                        </div>
                    </#if>
                </div>
            </#if>

            <div class="aimer-form-group">
                <label for="password" class="aimer-label">${msg("password")}</label>
                <div class="aimer-input-wrapper">
                    <input id="password" name="password" type="password"
                           class="aimer-input<#if messagesPerField.existsError('password')> has-error</#if>"
                           placeholder="${msg("password")}"
                           autocomplete="new-password" />
                </div>
                <#if messagesPerField.existsError('password')>
                    <div class="aimer-error">
                        <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('password'))?no_esc}</span>
                    </div>
                </#if>
            </div>

            <div class="aimer-form-group">
                <label for="password-confirm" class="aimer-label">${msg("passwordConfirm")}</label>
                <div class="aimer-input-wrapper">
                    <input id="password-confirm" name="password-confirm" type="password"
                           class="aimer-input<#if messagesPerField.existsError('password-confirm')> has-error</#if>"
                           placeholder="${msg("passwordConfirm")}"
                           autocomplete="new-password" />
                </div>
                <#if messagesPerField.existsError('password-confirm')>
                    <div class="aimer-error">
                        <svg class="aimer-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span>${kcSanitize(messagesPerField.getFirstError('password-confirm'))?no_esc}</span>
                    </div>
                </#if>
            </div>

            <input type="submit" class="aimer-btn aimer-btn-primary"
                   value="${msg("doRegister")}" />
        </form>

        <div class="aimer-footer">
            <a href="${url.loginUrl}">${kcSanitize(msg("backToLogin"))?no_esc}</a>
        </div>
    </#if>
</@layout.registrationLayout>
