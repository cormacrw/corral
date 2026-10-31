# Working glow offsets

`apps/web/app/components/BorderGlow.vue` picks a random lap fraction in
`onMounted` and uses it for a negative animation delay, scaled by `duration`.
Each mounted instance keeps its phase through reactive updates; a reload or
remount chooses again. Board and project overview cards, on desktop and
mobile, share this component.

The initial delay is zero on both the server and the first client render to
avoid hydration mismatches. The duration still controls seconds per full lap.
The existing `motion-safe:animate-glow-spin` rule leaves reduced-motion glows
unanimated at the registered `--glow-angle` initial value of `0deg`, regardless
of delay.
