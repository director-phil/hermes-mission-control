# Hermes Mission Control - Concept Designs

This repository is the standalone Hermes Mission Control project.

It is not `reliable-tradies-ops`, not the Railway RT dashboard, and not an app inside any other monorepo.

Expected repo:

```txt
/home/phillip_downs/Documents/GitHub/hermes-mission-control
```

Run the repo guard before edits:

```bash
bash scripts/guard-repo.sh
```

## Three Design Variants for Mission Control Dashboard

I've created three distinct concept designs for the AI Operations Center based on your vision. Each variant explores a different aspect of the mission control experience:

### 1. NOC Wall View
**Design stance**: Calm editorial with system health indicators

This variant focuses on the core dashboard view that shows real-time system status, agent activity, and key metrics. The design uses:
- Dark theme with vibrant accent colors for status indicators
- Grid-based status cards showing key metrics like agent count, system health, data integrity, and autonomous completion rate
- Animated radar visualization showing agent constellation with pulsing nodes
- Activity river that flows with live events

### 2. Constellation View
**Design stance**: Playful split with interactive agent relationships

This variant emphasizes the agent relationships and provides a more visual representation of how agents work together:
- Circular constellation layout with animated agent nodes
- Interactive hover effects that reveal detailed agent "DNA" cards
- Connection lines showing relationships between agents
- Activity indicators showing live working status
- Each agent has detailed statistics displayed when hovered

### 3. Heat Map View
**Design stance**: Utilitarian dense with data visualization

This variant focuses on data density and information architecture:
- Three heat maps showing different aspects: component activity, risk areas, and integration points
- Railway mission view showing system health status for key components
- AI team board displaying the operational status of each agent
- Live activity indicator showing continuous system monitoring
- Color-coded status indicators for quick visual scanning

## How to View the Designs

You can open each variant in your browser:
1. **NOC Wall**: `file:///home/phillip_downs/Documents/GitHub/hermes-mission-control/001-noc-wall/index.html`
2. **Constellation View**: `file:///home/phillip_downs/Documents/GitHub/hermes-mission-control/002-constellation-view/index.html`
3. **Heat Map View**: `file:///home/phillip_downs/Documents/GitHub/hermes-mission-control/003-heat-map-view/index.html`

Each design is fully interactive with hover effects, animations, and responsive layouts.
