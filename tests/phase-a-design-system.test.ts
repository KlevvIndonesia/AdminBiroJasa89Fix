import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

describe('PHASE A — ADMIN DESIGN SYSTEM FOUNDATION Verification Suite', () => {
  const indexCss = fs.readFileSync(path.resolve('src/styles/index.css'), 'utf8');
  const designTokensCss = fs.readFileSync(path.resolve('src/styles/design-tokens.css'), 'utf8');
  const globalsCss = fs.readFileSync(path.resolve('src/styles/globals.css'), 'utf8');

  const buttonTsx = fs.readFileSync(path.resolve('src/app/components/ui/button.tsx'), 'utf8');
  const inputTsx = fs.readFileSync(path.resolve('src/app/components/ui/input.tsx'), 'utf8');
  const textareaTsx = fs.readFileSync(path.resolve('src/app/components/ui/textarea.tsx'), 'utf8');
  const selectTsx = fs.readFileSync(path.resolve('src/app/components/ui/select.tsx'), 'utf8');
  const cardTsx = fs.readFileSync(path.resolve('src/app/components/ui/card.tsx'), 'utf8');
  const badgeTsx = fs.readFileSync(path.resolve('src/app/components/ui/badge.tsx'), 'utf8');
  const statusConfigTs = fs.readFileSync(path.resolve('src/app/components/ui/status-config.ts'), 'utf8');
  const alertTsx = fs.readFileSync(path.resolve('src/app/components/ui/alert.tsx'), 'utf8');
  const dashboardTsx = fs.readFileSync(path.resolve('src/app/components/Dashboard.tsx'), 'utf8');

  describe('1. CSS Cascade & Token Conflict Resolution', () => {
    it('index.css excludes conflicting default_theme.css and maintains single canonical cascade', () => {
      assert.strictEqual(
        indexCss.includes('default_theme.css'),
        false,
        'index.css must not import conflicting default_theme.css'
      );
      assert.ok(indexCss.includes("./fonts.css"), 'index.css must import fonts.css');
      assert.ok(indexCss.includes("./design-tokens.css"), 'index.css must import design-tokens.css');
      assert.ok(indexCss.includes("./globals.css"), 'index.css must import globals.css');
    });

    it('globals.css defines unified light and dark theme tokens without stale #030213', () => {
      assert.strictEqual(globalsCss.includes('#030213'), false, 'globals.css must not contain stale #030213');
      assert.ok(globalsCss.includes('--primary: #2563eb'), 'Light primary must be #2563eb');
      assert.ok(globalsCss.includes('--primary-hover: #1d4ed8'), 'Light primary hover must be #1d4ed8');
      assert.ok(globalsCss.includes('--primary-subtle: #eff6ff'), 'Light primary subtle must be #eff6ff');
      assert.ok(globalsCss.includes('--background: #f8fafc'), 'Light background must be #f8fafc');
      assert.ok(globalsCss.includes('color-scheme: light;'), 'Light color-scheme must be set');

      assert.ok(globalsCss.includes('--primary: #3b82f6'), 'Dark primary must be #3b82f6');
      assert.ok(globalsCss.includes('--background: #090d16'), 'Dark background must be #090d16');
      assert.ok(globalsCss.includes('--card: #0f172a'), 'Dark card surface must be #0f172a');
      assert.ok(globalsCss.includes('--input: #334155'), 'Dark input border must provide clear contrast against #0f172a');
      assert.ok(globalsCss.includes('color-scheme: dark;'), 'Dark color-scheme must be set');
    });

    it('design-tokens.css defines spacing, radius, shadow, and AA semantic status tokens', () => {
      for (const token of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8']) {
        assert.ok(designTokensCss.includes(token), `Missing spacing token ${token}`);
      }
      for (const token of ['--radius-small', '--radius-medium', '--radius-large', '--radius-pill']) {
        assert.ok(designTokensCss.includes(token), `Missing radius token ${token}`);
      }
      for (const token of ['--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg']) {
        assert.ok(designTokensCss.includes(token), `Missing shadow token ${token}`);
      }
      for (const semantic of ['success', 'warning', 'error', 'danger', 'info']) {
        assert.ok(designTokensCss.includes(`--color-${semantic}-fg`), `Missing --color-${semantic}-fg`);
        assert.ok(designTokensCss.includes(`--color-${semantic}-bg`), `Missing --color-${semantic}-bg`);
        assert.ok(designTokensCss.includes(`--color-${semantic}-border`), `Missing --color-${semantic}-border`);
      }
    });

    it('Tailwind @theme inline maps primary-hover, semantic status fg/bg/border, and shadow tokens', () => {
      assert.ok(globalsCss.includes('--color-primary-hover: var(--primary-hover)'));
      assert.ok(globalsCss.includes('--color-primary-subtle: var(--primary-subtle)'));
      assert.ok(globalsCss.includes('--color-status-success-fg: var(--color-success-fg)'));
      assert.ok(globalsCss.includes('--color-status-danger-fg: var(--color-danger-fg)'));
      assert.ok(globalsCss.includes('--shadow-xs: var(--shadow-xs)'));
      assert.ok(globalsCss.includes('--shadow-md: var(--shadow-md)'));
    });
  });

  describe('2. Base UI Components Standardization', () => {
    it('Button supports all required variants, sizes, and loading/disabled states', () => {
      for (const v of ['default', 'primary', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
        assert.ok(buttonTsx.includes(`${v}:`), `Button missing variant ${v}`);
      }
      for (const s of ['default', 'sm', 'lg', 'icon', '"icon-sm"', '"icon-lg"']) {
        assert.ok(buttonTsx.includes(`${s}:`), `Button missing size ${s}`);
      }
      assert.ok(buttonTsx.includes('loading?: boolean'), 'Button must support loading prop');
      assert.ok(buttonTsx.includes('Loader2'), 'Button must render spinner when loading');
      assert.ok(buttonTsx.includes('hover:bg-primary-hover'), 'Primary button must use primary-hover token');
    });

    it('Input uses forwardRef and supports inputSize, error state, disabled state, and optional icons', () => {
      assert.ok(inputTsx.includes('React.forwardRef'), 'Input must use React.forwardRef');
      assert.ok(inputTsx.includes('inputSize?:'), 'Input must support inputSize prop');
      assert.ok(inputTsx.includes('error?: boolean'), 'Input must support error prop');
      assert.ok(inputTsx.includes('leftIcon?:'), 'Input must support leftIcon');
      assert.ok(inputTsx.includes('rightIcon?:'), 'Input must support rightIcon');
      assert.ok(inputTsx.includes('border-input'), 'Input must use border-input token');
    });

    it('Textarea uses forwardRef and aligns border-input & error tokens', () => {
      assert.ok(textareaTsx.includes('React.forwardRef'), 'Textarea must use React.forwardRef');
      assert.ok(textareaTsx.includes('error?: boolean'), 'Textarea must support error prop');
      assert.ok(textareaTsx.includes('border-input'), 'Textarea must use border-input token');
    });

    it('Select aligns trigger heights, border-input, error state, and dark popover surface', () => {
      assert.ok(selectTsx.includes('size?: "sm" | "default" | "lg"'), 'SelectTrigger must support sm/default/lg sizes');
      assert.ok(selectTsx.includes('error?: boolean'), 'SelectTrigger must support error prop');
      assert.ok(selectTsx.includes('border-input bg-input-background'), 'SelectTrigger must align with Input surface/border');
      assert.ok(selectTsx.includes('bg-popover text-popover-foreground'), 'SelectContent must use popover tokens');
    });

    it('Card exports cardVariants and uses border-border + rounded-xl (12px)', () => {
      assert.ok(cardTsx.includes('cardVariants'), 'Card must export cardVariants');
      assert.ok(cardTsx.includes('rounded-xl border border-border'), 'Card must use unified radius and border tokens');
    });

    it('Badge and status-config support semantic variants while preserving business status mapping', () => {
      for (const v of ['default', 'neutral', 'primary', 'success', 'warning', 'danger', 'info', 'secondary', 'destructive', 'outline']) {
        assert.ok(badgeTsx.includes(`${v}:`), `Badge missing variant ${v}`);
      }
      assert.ok(statusConfigTs.includes('bg-status-success-bg text-status-success-fg border-status-success-border'));
      assert.ok(statusConfigTs.includes('BUSINESS_STATUS_MAP'), 'BUSINESS_STATUS_MAP must remain intact');
      assert.ok(alertTsx.includes('text-status-danger-fg bg-status-danger-bg'), 'Alert must consume semantic status tokens');
    });

    it('Dashboard chart consumes CSS variables instead of hardcoded #2563eb', () => {
      assert.strictEqual(dashboardTsx.includes('#2563eb'), false, 'Dashboard.tsx must not hardcode #2563eb in chart');
      assert.ok(dashboardTsx.includes('var(--primary)'), 'Dashboard.tsx chart must reference var(--primary)');
    });
  });
});
