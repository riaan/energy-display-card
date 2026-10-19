# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Repository restructured for HACS: the shipped file now lives in `dist/energy-display-card.js`; added dev tooling (lint, version check) and GitHub workflows.
- `documentationURL` now points to the GitHub repository.

## [1.1.0]

### Added

- Energy House card (`custom:energy-house-card`): illustrated house whose sky follows the sun, animated grid / solar / gas / water flows, show/hide toggles per node, footer metrics, swipe navigation and a visual editor.

## [1.0.0]

### Added

- Energy Display tile card (`custom:energy-display-card`): gauge, bar, value and chart tiles, day / week / month navigation, costs from price helpers and dynamic price sensors, visual editor, auto-detection of HomeWizard / SolarEdge / price entities, and sync groups.
