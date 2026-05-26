# Network Viewer 3D — Refactored

A professional, modular 3D infrastructure network viewer built with Three.js.

## Architecture

```
src/
├── index.html              # UI shell only
├── main.js                 # Application orchestrator
├── styles/
│   └── style.css           # All styling
├── data/
│   └── network.json        # External data (loaded via Fetch API)
└── modules/
    ├── AppState.js         # Centralized state management
    ├── DataLoader.js       # Async data loading with error handling
    ├── CoordinateSystem.js # Survey-to-scene coordinate transforms
    ├── SceneManager.js     # Three.js scene setup & camera control
    ├── GeometryBuilder.js  # Manhole/pipe/ground geometry construction
    ├── Raycaster.js        # Spatially-indexed raycasting (performance)
    └── UIManager.js        # DOM manipulation, popups, panels
```

## Key Improvements

### 1. Separation of Concerns
- **Before**: Single 1,000+ line HTML file mixing HTML, CSS, JS, and data
- **After**: 8 distinct files, each with a single responsibility

### 2. Dynamic Data Loading
- Data loaded asynchronously via `fetch()` from `data/network.json`
- Retry logic with exponential backoff (3 attempts)
- Validation of data structure and pipe references
- No code changes needed to update network data

### 3. Performance: Spatial Indexing
- Grid-based spatial hash for manholes and pipes
- Reduces raycast checks from O(n) to O(1) per cell
- Scales to thousands of objects without lag
- **Ready for three-mesh-bvh**: Import map configured, swap in for massive datasets

### 4. State Management
- `AppState` class encapsulates all mutable state
- No global variables — everything scoped and observable
- Error tracking with listener pattern
- Validation methods for data integrity

### 5. Error Handling
- Try/catch around all async operations
- User-visible error banner (not just console)
- Graceful degradation: missing basemap? App continues.
- Broken image URLs show placeholder text
- Orphaned pipe references logged but don't crash

## Usage

Serve the `src/` directory with any static file server:

```bash
# Python 3
python -m http.server 8080 --directory src

# Node.js
npx serve src

# PHP
php -S localhost:8080 -t src
```

Then open `http://localhost:8080`

## Upgrading to three-mesh-bvh

For massive datasets (>5,000 objects), replace the spatial grid with BVH:

```javascript
// In Raycaster.js, replace spatial grid with:
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// Build BVH on geometry
const bvh = new MeshBVH(geometry);
geometry.boundsTree = bvh;

// Raycasting becomes automatic acceleration
```

## Browser Support
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires ES modules and dynamic `import()` support.
