<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="${locale.currentLanguageTag!'en'}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link rel="stylesheet" href="${url.resourcesPath}/${style}">
        </#list>
    </#if>
    <script>
        (function() {
            var theme = localStorage.getItem('aimer-theme');
            if (theme === 'dark' || theme === 'light') {
                document.documentElement.setAttribute('data-theme', theme);
            }
        })();
    </script>
</head>
<body class="aimer-login ${bodyClass}">
    <div class="aimer-container">
        <div class="aimer-card">
            <div class="aimer-logo">
                <img src="${url.resourcesPath}/img/logo.svg" alt="${realm.displayName!'Aimer'}" />
            </div>
            <#nested "form">
            <#if displayInfo>
                <#nested "info">
            </#if>
        </div>
    </div>

    <button class="aimer-theme-toggle" type="button" onclick="toggleTheme()" aria-label="Toggle theme">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
    </button>

    <script>
        function toggleTheme() {
            var current = document.documentElement.getAttribute('data-theme');
            var next;
            if (current === 'dark') {
                next = 'light';
            } else if (current === 'light') {
                next = 'dark';
            } else {
                next = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
            }
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('aimer-theme', next);
        }
    </script>
</body>
</html>
</#macro>
