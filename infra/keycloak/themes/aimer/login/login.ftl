<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password'); section>
    <#if section = "form">
        <h1 class="aimer-title">${msg("loginAccountTitle")}</h1>

        <#if messagesPerField.existsError('username','password')>
            <div class="aimer-alert">
                <svg class="aimer-alert-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</span>
            </div>
        <#elseif message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <#if message.type = 'error'>
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
        </#if>

        <form id="kc-form-login" action="${url.loginAction}" method="post" onsubmit="login.disabled = true; return true;">
            <div class="aimer-form-group">
                <label for="username" class="aimer-label">${msg("email")}</label>
                <input id="username" name="username" type="text"
                       class="aimer-input<#if messagesPerField.existsError('username')> has-error</#if>"
                       value="${(login.username!'')}"
                       placeholder="${msg("email")}"
                       autofocus autocomplete="email" />
            </div>

            <div class="aimer-form-group">
                <label for="password" class="aimer-label">${msg("password")}</label>
                <div class="aimer-input-wrapper">
                    <input id="password" name="password" type="password"
                           class="aimer-input<#if messagesPerField.existsError('password')> has-error</#if>"
                           placeholder="${msg("password")}"
                           autocomplete="current-password" />
                    <button type="button" class="aimer-password-toggle" onclick="togglePassword()" aria-label="Toggle password visibility">
                        <svg id="eye-open" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                        <svg id="eye-closed" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                             style="display:none">
                            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 01-4.24-4.24"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="aimer-form-actions">
                <a href="#" class="aimer-link" onclick="openForgotModal(event)">${msg("doForgotPassword")}</a>
            </div>

            <input id="login-btn" name="login" type="submit"
                   class="aimer-btn aimer-btn-primary"
                   value="${msg("doLogIn")}" />
        </form>

        <#if realm.registrationAllowed>
            <div class="aimer-footer">
                ${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a>
            </div>
        </#if>

        <div class="aimer-modal-overlay" id="forgot-modal">
            <div class="aimer-modal">
                <h2 class="aimer-modal-title">${msg("doForgotPassword")}</h2>
                <p class="aimer-modal-body">
                    To reset your password, please contact your system administrator.
                </p>
                <div class="aimer-modal-actions">
                    <button type="button" class="aimer-btn aimer-btn-secondary" onclick="closeForgotModal()">
                        ${msg("doCancel")}
                    </button>
                </div>
            </div>
        </div>

        <script>
            function togglePassword() {
                var pwd = document.getElementById('password');
                var eyeOpen = document.getElementById('eye-open');
                var eyeClosed = document.getElementById('eye-closed');
                if (pwd.type === 'password') {
                    pwd.type = 'text';
                    eyeOpen.style.display = 'none';
                    eyeClosed.style.display = 'block';
                } else {
                    pwd.type = 'password';
                    eyeOpen.style.display = 'block';
                    eyeClosed.style.display = 'none';
                }
            }

            function openForgotModal(e) {
                e.preventDefault();
                document.getElementById('forgot-modal').classList.add('is-open');
            }

            function closeForgotModal() {
                document.getElementById('forgot-modal').classList.remove('is-open');
            }

            document.getElementById('forgot-modal').addEventListener('click', function(e) {
                if (e.target === this) closeForgotModal();
            });

            (function() {
                var form = document.getElementById('kc-form-login');
                var username = document.getElementById('username');
                var password = document.getElementById('password');
                var btn = document.getElementById('login-btn');

                function updateBtn() {
                    btn.disabled = !username.value.trim() || !password.value.trim();
                }

                updateBtn();
                username.addEventListener('input', updateBtn);
                password.addEventListener('input', updateBtn);
            })();
        </script>
    </#if>
</@layout.registrationLayout>
