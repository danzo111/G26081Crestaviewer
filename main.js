/**
 * main.js — Network Viewer Application Entry Point
 * 
 * Features:
 * - Search & filter manholes by ID, name, type
 * - Flow direction arrows (higher invert → lower invert)
 * - Sortable data table with virtual scrolling
 * - Keyboard shortcuts: T (table), F (flow), M (measure), 1-6 (views)
 */

import * as THREE from 'three';
import { appState } from './modules/AppState.js';
import { dataLoader } from './modules/DataLoader.js';
import { CoordinateSystem } from './modules/CoordinateSystem.js';
import { SceneManager } from './modules/SceneManager.js';
import { GeometryBuilder } from './modules/GeometryBuilder.js';
import { RaycasterManager } from './modules/Raycaster.js';
import { UIManager } from './modules/UIManager.js';
import { SearchIndex } from './modules/SearchIndex.js';
import { FlowArrows } from './modules/FlowArrows.js';
import { DataTable } from './modules/DataTable.js';
import { HelpModal } from './modules/HelpModal.js';

class NetworkViewerApp {
  constructor() {
    this.ui = new UIManager();
    this.sceneManager = null;
    this.coordSystem = null;
    this.geometryBuilder = null;
    this.raycaster = null;
    this.basemapMesh = null;
    this.groundObjects = {};
    this.searchIndex = null;
    this.flowArrows = null;
    this.dataTable = null;
    this.helpModal = null;
    this._searchDebounceTimer = null;

    this._bindMethods();
  }

  _bindMethods() {
    this._onViewportClick = this._onViewportClick.bind(this);
    this._onViewportMouseMove = this._onViewportMouseMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onMeasureClick = this._onMeasureClick.bind(this);
    this._animate = this._animate.bind(this);
  }

  async init() {
    try {
      this.ui.setProgress(5, 'Initializing renderer...');
      await this._yieldFrame();

      this.sceneManager = new SceneManager('viewport');

      this.ui.setProgress(15, 'Loading network data...');
      const networkData = await dataLoader.loadNetworkData('network.json');

      this.ui.setProgress(30, 'Setting up coordinates...');
      await this._yieldFrame();
      this.coordSystem = new CoordinateSystem(networkData);
      this.ui.setCRSLabel(this.coordSystem.getCRSLabel());

      this.ui.setProgress(32, 'Building search index...');
      await this._yieldFrame();
      this.searchIndex = new SearchIndex(networkData, this.coordSystem);

      this.ui.setProgress(40, 'Building geometry...');
      await this._yieldFrame();
      this.geometryBuilder = new GeometryBuilder(this.sceneManager, this.coordSystem);

      const mhResult = this.geometryBuilder.buildManholes(networkData.manholes);
      const pipeResult = this.geometryBuilder.buildPipes(networkData.pipes, appState.mhLookup);

      // Flow arrows (uses appState.pipeData set inside buildPipes)
      this.flowArrows = new FlowArrows(
        this.sceneManager.scene,
        appState.pipeData,
        this.coordSystem
      );

      this.ui.setProgress(60, 'Building ground & basemap...');
      await this._yieldFrame();
      this.groundObjects = this.geometryBuilder.buildGround();
      this.geometryBuilder.buildDropLines(networkData.manholes);
      await this._loadBasemap();

      this.ui.setProgress(80, 'Setting up interactions...');
      await this._yieldFrame();
      this.raycaster = new RaycasterManager(
        this.sceneManager.camera,
        this.sceneManager.renderer
      );
      this.raycaster.buildManholeIndex(appState.mhInstData);
      this.raycaster.buildPipeIndex(appState.pipeData);

      this._setupEventListeners();
      this._setupUIControls();
      this._setupSearchAndTable();
      this._setupFlowToggle();
      this._setupHelpModal();

      this.ui.setProgress(90, 'Framing scene...');
      await this._yieldFrame();
      const box = this.coordSystem.computeBoundingBox(networkData.manholes);
      this.sceneManager.frameCamera(box, 0.5);

      this.ui.setProgress(100, 'Ready');
      await this._yieldFrame();
      await this._yieldFrame();
      this.ui.hideLoading();
      this._animate();

    } catch (error) {
      this._handleFatalError(error);
    }
  }

  async _loadBasemap() {
    try {
      const textureLoader = new THREE.TextureLoader();
      const texture = await new Promise((resolve, reject) => {
        textureLoader.load(
          'basemap.png',
          (tex) => resolve(tex),
          undefined,
          (err) => reject(new Error(`Basemap load failed: ${err.message}`))
        );
      });
      this.basemapMesh = this.geometryBuilder.buildBasemap(texture);
    } catch (error) {
      appState.addError(error.message, 'Basemap');
      console.warn('Basemap not loaded — continuing without it');
    }
  }

  _yieldFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  /* ── Event Listeners ──────────────────────────────────────────── */

  _setupEventListeners() {
    const viewport = document.getElementById('viewport');
    viewport.addEventListener('click', this._onViewportClick);
    viewport.addEventListener('mousemove', this._onViewportMouseMove);
    document.addEventListener('keydown', this._onKeyDown);

    document.querySelector('.logo')?.addEventListener('dblclick', () => {
      const box = this.coordSystem.computeBoundingBox(appState.networkData.manholes);
      this.sceneManager.frameCamera(box, 0.5);
      this._setCameraView('iso');
    });
  }

  _setupUIControls() {
    // View buttons
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setCameraView(btn.dataset.view));
    });

    // Layer controls
    this.ui.setupLayerControls({
      onManholeLayer: (visible) => {
        if (this.geometryBuilder.iCoversSewer) this.geometryBuilder.iCoversSewer.visible = visible;
        if (this.geometryBuilder.iCoversStorm) this.geometryBuilder.iCoversStorm.visible = visible;
        if (this.geometryBuilder.iShafts) this.geometryBuilder.iShafts.visible = visible;
      },
      onPipeLayer: (visible) => {
        const storm = this.sceneManager.scene.getObjectByName('pipes_storm');
        const sewer = this.sceneManager.scene.getObjectByName('pipes_sewer');
        if (storm) storm.visible = visible;
        if (sewer) sewer.visible = visible;
      },
      onBasemapLayer: (visible) => {
        if (this.basemapMesh) this.basemapMesh.visible = visible;
      },
      onGroundLayer: (visible) => {
        if (this.groundObjects.plane) this.groundObjects.plane.visible = visible;
      }
    });

    // Slider controls
    this.ui.setupSliderControls({
      onElevChange: (offset) => {
        if (this.basemapMesh) {
          const baseElev = appState.networkData?.metadata?.basemap_elev || 1546.83;
          this.basemapMesh.position.y = (baseElev + offset) - this.coordSystem.originElev;
        }
      },
      onOpacityChange: (opacity) => {
        if (this.basemapMesh?.material) {
          this.basemapMesh.material.opacity = opacity / 100;
        }
      }
    });

    // Measure button
    this.ui.elements.measureBtn?.addEventListener('click', () => {
      const newMode = !appState.measureMode;
      appState.setMeasureMode(newMode);
      this.ui.setMeasureMode(newMode);
    });
  }

  /* ── Search & Data Table ──────────────────────────────────────── */

  _setupSearchAndTable() {
    // Create data panel
    if (!document.getElementById('data-panel')) {
      const panel = document.createElement('div');
      panel.id = 'data-panel';
      panel.innerHTML = `
        <div class="dt-search">
          <input type="text" id="dt-search-input" placeholder="Search ID, name, or type..." autocomplete="off" spellcheck="false">
          <div class="dt-search-hint">Press Enter to select first result · T to toggle panel</div>
        </div>
        <div class="dt-filters">
          <button class="dt-filter-btn active" data-filter="all">All</button>
          <button class="dt-filter-btn sewer" data-filter="Sewer">Sewer</button>
          <button class="dt-filter-btn storm" data-filter="Stormwater">Storm</button>
        </div>
        <div id="dt-table-container" style="flex:1;overflow:hidden;"></div>
      `;
      document.body.appendChild(panel);

      // Toggle button
      const toggle = document.createElement('button');
      toggle.id = 'data-toggle';
      toggle.innerHTML = '☰';
      toggle.title = 'Toggle data table (T)';
      document.body.appendChild(toggle);

      toggle.addEventListener('click', () => this._toggleDataPanel());

      // Filter buttons
      panel.querySelectorAll('.dt-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          panel.querySelectorAll('.dt-filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this._applyFilter();
        });
      });

      // Search input with debounce
      const input = panel.querySelector('#dt-search-input');
      input.addEventListener('input', () => {
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => this._applyFilter(), 150);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const firstVisible = this.dataTable?.filteredData[0];
          if (firstVisible) {
            this._flyToManhole(firstVisible.index);
            this.dataTable?.setSelectedIndex(firstVisible.index);
          }
        }
      });
    }

    // Init table
    const tableContainer = document.getElementById('dt-table-container');
    if (tableContainer) {
      this.dataTable = new DataTable('dt-table-container', {
        onRowClick: (data) => {
          this._flyToManhole(data.index);
          this.dataTable.setSelectedIndex(data.index);
        }
      });
      this.dataTable.setData(appState.networkData.manholes, this.searchIndex);
    }
  }

  _toggleDataPanel() {
    const panel = document.getElementById('data-panel');
    const toggle = document.getElementById('data-toggle');
    const viewport = document.getElementById('viewport');
    panel?.classList.toggle('visible');
    toggle?.classList.toggle('active', panel?.classList.contains('visible'));
    viewport?.classList.toggle('has-data-panel', panel?.classList.contains('visible'));
  }

  _applyFilter() {
    const input = document.getElementById('dt-search-input');
    const query = input?.value?.trim() || '';
    const activeFilter = document.querySelector('.dt-filter-btn.active');
    const type = activeFilter?.dataset.filter === 'all' ? null : activeFilter?.dataset.filter;

    // ── ISOLATE NETWORK BY TYPE ──
    // When Sewer selected: show only Sewer manholes + Sewer pipes
    // When Stormwater selected: show only Stormwater manholes + Stormwater pipes
    // When All: show everything
    this._isolateNetworkType(type);

    // Apply text search to table only
    if (!query) {
      this.dataTable?.filter(type ? d => d.type === type : null);
    } else {
      const indices = this.searchIndex.filterManholes({ type, searchQuery: query });
      const indexSet = new Set(indices);
      this.dataTable?.filter(d => indexSet.has(d.index));
    }
  }

  /**
   * Isolate network by type — hides all manholes/pipes of other types.
   * @param {string|null} type — 'Sewer', 'Stormwater', or null (show all)
   */
  _isolateNetworkType(type) {
    const showSewerMH = !type || type === 'Sewer';
    const showStormMH = !type || type === 'Stormwater';
    const showSewerPipe = !type || type === 'Sewer';
    const showStormPipe = !type || type === 'Stormwater';

    // Manhole covers
    if (this.geometryBuilder.iCoversSewer) {
      this.geometryBuilder.iCoversSewer.visible = showSewerMH;
    }
    if (this.geometryBuilder.iCoversStorm) {
      this.geometryBuilder.iCoversStorm.visible = showStormMH;
    }

    // Shafts — hide shafts of filtered-out manholes by rebuilding visibility mask
    // Since shafts are one InstancedMesh, we use scale=0 to hide individual shafts
    this._setShaftVisibility(type);

    // Pipes
    const stormPipe = this.sceneManager.scene.getObjectByName('pipes_storm');
    const sewerPipe = this.sceneManager.scene.getObjectByName('pipes_sewer');
    if (stormPipe) stormPipe.visible = showStormPipe;
    if (sewerPipe) sewerPipe.visible = showSewerPipe;

    // Update layer checkboxes to reflect isolation
    const mhCheckbox = document.getElementById('layer-mh');
    const pipeCheckbox = document.getElementById('layer-pipes');
    if (mhCheckbox) mhCheckbox.checked = true; // Always on, but filtered by type
    if (pipeCheckbox) pipeCheckbox.checked = true;
  }

  /**
   * Hide individual shafts by scaling them to zero.
   * Since all shafts share one InstancedMesh, we scale filtered ones to 0.
   */
  _setShaftVisibility(type) {
    if (!this.geometryBuilder.iShafts) return;

    const dummy = new THREE.Object3D();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (let i = 0; i < appState.mhInstData.length; i++) {
      const mh = appState.mhInstData[i];
      const shouldShow = !type || mh.type === type;

      this.geometryBuilder.iShafts.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);

      if (shouldShow) {
        // Restore original scale (stored in mhInstData)
        dummy.position.copy(position);
        dummy.quaternion.copy(quaternion);
        dummy.scale.set(mh.r * 2, mh.h, mh.r * 2);
      } else {
        // Scale to zero to hide
        dummy.position.copy(position);
        dummy.quaternion.copy(quaternion);
        dummy.scale.set(0, 0, 0);
      }
      dummy.updateMatrix();
      this.geometryBuilder.iShafts.setMatrixAt(i, dummy.matrix);
    }

    this.geometryBuilder.iShafts.instanceMatrix.needsUpdate = true;
  }

  _setupFlowToggle() {
    const btn = document.createElement('button');
    btn.id = 'flow-toggle';
    btn.textContent = 'Toggle Flow Direction';
    btn.title = 'Toggle flow direction (F)';
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      const on = this.flowArrows?.toggle();
      btn.textContent = on ? 'Hide Flow Direction' : 'Toggle Flow Direction';
      btn.classList.toggle('active', on);
    });
  }

  /* ── Selection & Camera ───────────────────────────────────────── */

  _setupHelpModal() {
    this.helpModal = new HelpModal();
    // Auto-show on first visit after a short delay
    setTimeout(() => this.helpModal.maybeAutoShow(), 1200);
  }

  _flyToManhole(index) {
    const mh = appState.mhInstData[index];
    if (!mh) return;

    appState.clearSelection();
    this.geometryBuilder.resetManholeColors();
    this.geometryBuilder.clearPipeHighlight();

    this.geometryBuilder.setManholeColor(index, this.geometryBuilder.COL_HOVER);
    const highlight = this.geometryBuilder.createManholeHighlight(mh);
    this.sceneManager.scene.add(highlight);
    appState.setSelection('manhole', index, highlight);

    const target = mh.topS.clone();
    const offset = new THREE.Vector3(18, 14, 18);
    const camPos = target.clone().add(offset);
    this.sceneManager.animateCamera(camPos, target, 700);

    this.ui.renderManholePopup(mh);
    this.dataTable?.setSelectedIndex(index);
  }

  _onViewportClick(event) {
    if (appState.measureMode) {
      this._onMeasureClick(event);
      return;
    }

    const result = this.raycaster.castRay(event);

    if (!result) {
      appState.clearSelection();
      this.geometryBuilder.resetManholeColors();
      this.geometryBuilder.clearPipeHighlight();
      this.ui.hidePopup();
      this.ui.hideProfile();
      return;
    }

    appState.clearSelection();
    this.ui.hidePopup();

    const { type, idx } = result;

    if (type === 'manhole') {
      this._selectManhole(idx);
    } else {
      this._selectPipe(idx);
    }
  }

  _selectManhole(idx) {
    const mh = appState.mhInstData[idx];
    if (!mh) return;

    this.geometryBuilder.resetManholeColors();
    this.geometryBuilder.clearPipeHighlight();
    this.geometryBuilder.setManholeColor(idx, this.geometryBuilder.COL_HOVER);

    const highlight = this.geometryBuilder.createManholeHighlight(mh);
    this.sceneManager.scene.add(highlight);
    appState.setSelection('manhole', idx, highlight);

    this.ui.renderManholePopup(mh);
    this.dataTable?.setSelectedIndex(idx);
  }

  _selectPipe(idx) {
    const pd = appState.pipeData[idx];
    if (!pd) return;

    this.geometryBuilder.resetManholeColors();
    const highlight = this.geometryBuilder.setPipeHighlight(idx);
    appState.setSelection('pipe', idx, highlight);

    if (pd.fromIdx >= 0) {
      this.geometryBuilder.setManholeColor(pd.fromIdx, this.geometryBuilder.COL_PIPE_MH);
      const glow = this.geometryBuilder.createConnectedHighlight(appState.mhInstData[pd.fromIdx]);
      this.sceneManager.scene.add(glow);
      appState.addConnectedHighlight(glow);
    }
    if (pd.toIdx >= 0) {
      this.geometryBuilder.setManholeColor(pd.toIdx, this.geometryBuilder.COL_PIPE_MH);
      const glow = this.geometryBuilder.createConnectedHighlight(appState.mhInstData[pd.toIdx]);
      this.sceneManager.scene.add(glow);
      appState.addConnectedHighlight(glow);
    }

    this.ui.renderPipePopup(pd, (pipeData) => {
      this.ui.showProfile();
      this.ui.drawProfile(pipeData);
    });
  }

  _onViewportMouseMove(event) {
    const result = this.raycaster.castRay(event);
    document.getElementById('viewport').style.cursor = result ? 'pointer' : 'default';
  }

  _onMeasureClick(event) {
    const targets = [this.groundObjects.plane, this.basemapMesh].filter(Boolean);
    const point = this.raycaster.castRayToGround(event, targets);
    if (!point) return;

    const marker = this.geometryBuilder.createMeasureMarker(point);
    this.sceneManager.scene.add(marker);
    appState.addMeasurePoint(point, marker);

    const points = appState.measurePoints;
    if (points.length === 1) {
      this.ui.setMeasureResult('Click second point...');
    } else if (points.length === 2) {
      const dist = points[0].distanceTo(points[1]);
      this.ui.setMeasureResult(`Distance: <span style="font-size:18px;">${dist.toFixed(2)} m</span>`);
      setTimeout(() => appState.clearMeasurePoints(), 3000);
    }
  }

  _onKeyDown(event) {
    if (event.target.tagName === 'INPUT') return;

    switch (event.key.toLowerCase()) {
      case '1': this._setCameraView('iso'); break;
      case '2': this._setCameraView('top'); break;
      case '3': this._setCameraView('front'); break;
      case '4': this._setCameraView('right'); break;
      case '5': this._setCameraView('left'); break;
      case '6': this._setCameraView('back'); break;
      case 'm':
        this.ui.elements.measureBtn?.click();
        break;
      case 'f':
        document.getElementById('flow-toggle')?.click();
        break;
      case 't':
        this._toggleDataPanel();
        break;
      case '?':
        this.helpModal?.toggle();
        break;
      case 'escape':
        if (appState.measureMode) this.ui.elements.measureBtn?.click();
        this.ui.hidePopup();
        this.ui.hideProfile();
        appState.clearSelection();
        this.geometryBuilder.resetManholeColors();
        this.geometryBuilder.clearPipeHighlight();
        break;
    }
  }

  _setCameraView(viewName) {
    const box = this.coordSystem.computeBoundingBox(appState.networkData.manholes);
    const targetPos = this.sceneManager.getViewPosition(viewName, box);
    const centre = new THREE.Vector3();
    box.getCenter(centre);

    this.sceneManager.animateCamera(targetPos, centre, 800);
    appState.setCurrentView(viewName);
    this.ui.setActiveView(viewName);
  }

  /* ── Animation Loop ───────────────────────────────────────────── */

  _animate() {
    requestAnimationFrame(this._animate);
    this.sceneManager.controls.update();
    this.flowArrows?.update(this.sceneManager.camera);

    const droplines = this.sceneManager.scene.getObjectByName('droplines');
    if (droplines) {
      const dist = this.sceneManager.camera.position.distanceTo(this.sceneManager.controls.target);
      droplines.visible = dist < 300;
    }

    this.sceneManager.render();
    this.ui.updateFPS();
  }

  _handleFatalError(error) {
    console.error('Fatal error:', error);
    appState.addError(error.message, 'App.init');
    this.ui.setProgress(0, 'Error');

    const loading = document.getElementById('loading');
    if (loading) {
      loading.innerHTML = `
        <div style="color:#E74C3C; font-family:monospace; text-align:center;">
          <h3>⚠ Application Error</h3>
          <p>${error.message}</p>
          <p style="font-size:11px; color:#8BA3BC;">Check browser console</p>
        </div>
      `;
    }
  }
}

const app = new NetworkViewerApp();
app.init().catch(err => console.error('Unhandled init error:', err));