Set-Location 'C:\Users\evank\tare-mobile'

Write-Output '=== any greens left? ==='
$left = Get-ChildItem app, src -Recurse -Include *.ts, *.tsx |
  Select-String -Pattern '63,\s*180,\s*137|#3FB489|#5FD3A6|#2E9A73|#17795A|#1E9270|#0F5C43|#04231A'
if ($left) { foreach ($h in $left) { Write-Output ("  {0}:{1}  {2}" -f $h.Filename, $h.LineNumber, $h.Line.Trim()) } }
else { Write-Output '  none' }

Write-Output '=== typecheck ==='
& .\node_modules\.bin\tsc.cmd --noEmit
Write-Output "tsc exit: $LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { exit 1 }

Remove-Item _green.ps1, _icons.ps1 -Force -ErrorAction SilentlyContinue
git add -A
git commit -q -m @"
The handset wears the logo's blue, and the real icon

Three things were off. The brand: the console adopted the logo's glassy blue
months ago and the handset never did, so one product was green on the phone
and blue on the web. Both palettes now carry the console's own tokens rather
than a handset approximation - #34AEDC / #6FDDF2 / #1E7CA4 on dark, and on
paper #146C8C (5.91:1 on white) with #1B7FA3 (4.55:1).

That light-mode brandLit is a fix as well as a recolour. It is the icon colour
on the pale Home tiles, where no dark surface carries it, and the green it
replaces measured about 3.9:1 there - under AA.

Four hardcoded rgba(63,180,137) greens bypassed the palette entirely and would
have stayed green through any token change. They are wash() now, so they track
the brand and stop being the wrong shade in light mode. The aurora PNGs were
authored green too; rather than ship new binaries they take tintColor, which
recolours an alpha image whole while keeping its falloff, so the light in the
room follows the palette in both themes.

Icons: icon.png, adaptive-icon.png, splash.png and favicon.png were 12-17KB
placeholders. They are now rendered from public/scanified-logo.png (1139x928,
real alpha) - alpha-trimmed first so the mark is not swimming in padding next
to every other app on the home screen, opaque floor on the iOS icon because it
cannot carry alpha, 60% coverage on the Android foreground to stay inside the
adaptive safe circle whichever mask the launcher applies. Splash and adaptive
backgrounds moved from #0E1214 to the palette floor #07090A.
"@
Write-Output '=== result ==='
git --no-pager log --oneline -2
git --no-pager show --stat --oneline HEAD | Select-Object -First 12
git status --short
Remove-Item _ship.ps1 -Force -ErrorAction SilentlyContinue
