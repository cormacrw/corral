<template>
  <AppCard>
    <template #header>
      <h2 class="font-medium">
        Appearance
      </h2>
    </template>
    <div class="flex flex-col gap-5">
      <SettingsField
        title="Colour mode"
        description="Primary colour, light palette and font are configured in app.config.ts and main.css."
      >
        <SettingsColorMode />
      </SettingsField>
      <SettingsField
        title="Dark background"
        description="Background, surfaces and borders in dark mode. Saved for this device only."
      >
        <DarkNeutralPicker />
      </SettingsField>
      <SettingsField
        title="Layout"
        description="Auto uses the mobile layout on a phone or the installed app. Saved for this device only."
      >
        <SettingsLayoutMode />
      </SettingsField>
    </div>
  </AppCard>
</template>
