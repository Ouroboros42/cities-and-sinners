import { patch } from "../utils/patch.js";
import { Sprite } from "../utils/sprite.js";
import { PointSourceGeometry } from "./point-source/geometry.js";
import { PointSourceMesh } from "./point-source/mesh.js";
import { Framebuffer } from "../utils/framebuffer.js";
import { Region } from "../utils/region.js";

Hooks.once("init", () => {
    patch("LightingLayer.prototype._configureChannels", "OVERRIDE", function ({ darkness, backgroundColor } = {}) {
        this._pv_version = ++this.version;

        const channels = configureChannels({
            darkness,
            backgroundColor,
            daylightColor: this._pv_daylightColor,
            darknessColor: this._pv_darknessColor
        });

        return channels;
    });

    patch("LightingLayer.prototype.draw", "OVERRIDE", async function () {
        let stage = this._pv_stage;

        if (stage) {
            stage.transform.reference = canvas.stage.transform;

            for (const child of stage.children) {
                child._parentID = -1;
            }
        } else {
            stage = this._pv_stage = new PointSourceContainer();
            stage.transform = new SynchronizedTransform(canvas.stage.transform);
            stage.areas = stage.addChild(new DrawBuffersContainer(
                WebGL2RenderingContext.COLOR_ATTACHMENT0,
                WebGL2RenderingContext.COLOR_ATTACHMENT1,
                WebGL2RenderingContext.COLOR_ATTACHMENT2
            ));
            stage.visions = stage.addChild(new DrawBuffersContainer(
                WebGL2RenderingContext.COLOR_ATTACHMENT0,
                WebGL2RenderingContext.COLOR_ATTACHMENT1
            ));

            const container = stage.addChild(new DrawBuffersContainer(
                WebGL2RenderingContext.COLOR_ATTACHMENT0
            ));

            const geometry = new PIXI.Geometry()
                .addAttribute("aVertexPosition", new PIXI.Buffer(new Float32Array([-1, -1, +1, -1, +1, +1, -1, +1]), true, false), 2, false, PIXI.TYPES.FLOAT)
                .addAttribute("aCenterRadius", new PIXI.Buffer(new Float32Array([]), false, false), 3, false, PIXI.TYPES.FLOAT, undefined, undefined, true);
            const shader = MinFOVShader.instance;

            stage.minFOV = container.addChild(new PIXI.Mesh(geometry, shader, undefined, PIXI.DRAW_MODES.TRIANGLE_FAN));
            stage.minFOV.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
            stage.minFOV.visible = false;
            stage.minFOV.geometry.instanceCount = 0;

            stage.lights = container.addChild(new PIXI.Container());
            stage.roofs = container.addChild(new ColorMaskContainer(true, false, false, false));
            stage.baseTextures = [];
        }

        let buffer = this._pv_buffer;

        if (!buffer) {
            buffer = this._pv_buffer = Framebuffer.create(
                "lighting",
                [
                    {
                        format: PIXI.FORMATS.RGBA,
                        type: PIXI.TYPES.UNSIGNED_BYTE
                    },
                    {
                        format: PIXI.FORMATS.RGBA,
                        type: PIXI.TYPES.UNSIGNED_BYTE
                    },
                    {
                        format: PIXI.FORMATS.RGB,
                        type: PIXI.TYPES.UNSIGNED_BYTE
                    }
                ]
            );

            buffer.on("update", buffer => {
                buffer.render(canvas.app.renderer, this._pv_stage);
            });
        }

        this._pv_bgRect = canvas.dimensions.rect.clone().pad(canvas.dimensions.size);

        if (this._pv_active === undefined) {
            this._pv_initializeArea(this);
            this._pv_areas = [];
        }

        this._pv_active = true;
        this._pv_fov = Region.from(this._pv_bgRect);
        this._pv_los = null;
        this._pv_flags_updateArea = true;

        canvas._pv_limits.update();

        await PlaceablesLayer.prototype.draw.call(this);

        this.globalLight = canvas.scene.data.globalLight;
        this.darknessLevel = canvas.scene.data.darkness;

        this._pv_geometry = new PointSourceGeometry(this._pv_fov, this._pv_los, canvas.dimensions._pv_inset);
        this._pv_shader = new LightingAreaShader(this);

        if (!this._pv_mesh) {
            this._pv_mesh = new PointSourceMesh(this._pv_geometry, this._pv_shader);
            this._pv_mesh.blendMode = PIXI.BLEND_MODES.NORMAL_NPM;
            this._pv_mesh.colorMask.alpha = false;
        } else {
            this._pv_mesh.geometry = this._pv_geometry;
            this._pv_mesh.shader = this._pv_shader;
        }

        this._pv_globalLight = this.globalLight;

        this._pv_sightLimit = Math.max(canvas.scene.getFlag("perfect-vision", "sightLimit") ?? Infinity, 0) / canvas.dimensions.distance * canvas.dimensions.size;

        let daylightColor = canvas.scene.getFlag("perfect-vision", "daylightColor") ?? "";

        if (daylightColor === "") {
            daylightColor = CONFIG.Canvas.daylightColor;
        }

        this._pv_daylightColor = sanitizeLightColor(daylightColor);

        let darknessColor = canvas.scene.getFlag("perfect-vision", "darknessColor") ?? "";

        if (darknessColor === "") {
            darknessColor = CONFIG.Canvas.darknessColor;
        }

        this._pv_darknessColor = sanitizeLightColor(darknessColor);
        this._pv_darknessLevel = this.darknessLevel;
        this._pv_saturationLevel = Math.clamped(canvas.scene.getFlag("perfect-vision", "saturation") ?? (
            game.system.id === "pf2e" && canvas.sight.rulesBasedVision ? Math.clamped((0.75 - this.darknessLevel) / 0.5, 0, 1) : 1 - this.darknessLevel), 0, 1);
        this._pv_channels = this.channels;
        this._pv_version = this.version;
        this._pv_zIndex = -Infinity;
        this._pv_data_globalLight = canvas.scene.data.globalLight;
        this._pv_data_globalLightThreshold = canvas.scene.data.globalLightThreshold;

        this.lighting = this.addChildAt(new PIXI.Container(), 0);
        this.background = this.lighting.addChild(this._drawBackgroundContainer());
        this.illumination = this.lighting.addChild(this._drawIlluminationContainer());
        this.coloration = this.lighting.addChild(this._drawColorationContainer());
        this._pv_delimiter = canvas._pv_highlights_overhead.delimiter.addChild(new ObjectHUD(this)).addChild(this._pv_drawDelimiterContainer());

        // Draw the background
        this.illumination.background.x = this._pv_bgRect.x;
        this.illumination.background.y = this._pv_bgRect.y;
        this.illumination.background.width = this._pv_bgRect.width;
        this.illumination.background.height = this._pv_bgRect.height;

        // Activate animation
        this.activateAnimation();

        return this;
    });

    patch("LightingLayer.prototype._drawColorationContainer", "OVERRIDE", function () {
        const c = new PointSourceContainer();

        c.filter = new PIXI.filters.AlphaFilter(1.0);
        c.filter.blendMode = PIXI.BLEND_MODES.ADD;
        c.filter.resolution = canvas.app.renderer.resolution;
        c.filter.multisample = PIXI.MSAA_QUALITY.NONE;
        c.filters = [c.filter];
        c.filterArea = canvas.app.renderer.screen;
        c.sortableChildren = true;

        return c;
    });

    patch("LightingLayer.prototype._drawIlluminationContainer", "OVERRIDE", function () {
        const c = new PointSourceContainer();

        c.background = c.addChild(new Sprite(IlluminationBackgroundShader.instance));
        c.primary = c.addChild(new PIXI.Container());
        c.lights = c.primary.addChild(new PIXI.Container());
        c.lights.sortableChildren = true;

        if (game.user.isGM) {
            c._pv_filter = new IlluminationContainerFilter();
            c._pv_filter.resolution = canvas.app.renderer.resolution;
            c._pv_filter.multisample = PIXI.MSAA_QUALITY.NONE;

            if (canvas.performance.blur.illumination) {
                c.filter = canvas.createBlurFilter();
                c.filters = [c._pv_filter, c.filter];
            } else {
                c.filter = c._pv_filter;
                c.filters = [c.filter];
            }
        } else {
            c.filter = canvas.performance.blur.illumination ? canvas.createBlurFilter() : new PIXI.filters.AlphaFilter();
            c.filters = [c.filter];
        }

        c.filter.blendMode = PIXI.BLEND_MODES.MULTIPLY;
        c.filter.resolution = canvas.app.renderer.resolution;
        c.filter.multisample = PIXI.MSAA_QUALITY.NONE;
        c.filterArea = canvas.app.renderer.screen;

        return c;
    });

    patch("LightingLayer.prototype._drawBackgroundContainer", "OVERRIDE", function () {
        const c = new PointSourceContainer();

        c.filter = new PIXI.filters.AlphaFilter(1.0);
        c.filter.blendMode = PIXI.BLEND_MODES.NORMAL;
        c.filter.resolution = canvas.app.renderer.resolution;
        c.filter.multisample = PIXI.MSAA_QUALITY.NONE;
        c.filters = [c.filter];
        c.filterArea = canvas.app.renderer.screen;
        c.sortableChildren = true;

        return c;
    });

    patch("LightingLayer.prototype.initializeSources", "POST", function () {
        for (const area of this._pv_areas) {
            area._pv_flags_updateLOS = true;
        }
    });

    patch("LightingLayer.prototype.refresh", "OVERRIDE", function ({ darkness, backgroundColor } = {}) {
        this._pv_data_globalLight = canvas.scene.data.globalLight;
        this._pv_data_globalLightThreshold = canvas.scene.data.globalLightThreshold;

        const priorDarknessLevel = this.darknessLevel;
        const bgChanged = backgroundColor !== undefined;
        let darknessChanged = darkness !== undefined && darkness !== priorDarknessLevel;

        this._pv_bgChanged = bgChanged;

        this.darknessLevel = darkness = Math.clamped(darkness ?? this.darknessLevel, 0, 1);
        this._pv_darknessLevel = darkness;

        let saturation;

        if (this._pv_preview?.hasOwnProperty("saturation")) {
            saturation = this._pv_preview.saturation ?? null;
        } else {
            saturation = canvas.scene.getFlag("perfect-vision", "saturation") ?? null;

            const forceSaturation = canvas.scene.getFlag("perfect-vision", "forceSaturation");

            if (forceSaturation !== undefined && !forceSaturation) {
                saturation = null;
            }
        }

        if (saturation === null) {
            if (game.system.id === "pf2e" && canvas.sight.rulesBasedVision) {
                saturation = (0.75 - darkness) / 0.5;
            } else {
                saturation = 1 - darkness;
            }
        }

        this._pv_saturationLevel = saturation = Math.clamped(saturation, 0, 1);

        let sightLimit;

        if (this._pv_preview?.hasOwnProperty("sightLimit")) {
            sightLimit = this._pv_preview.sightLimit;
        } else {
            sightLimit = canvas.scene.getFlag("perfect-vision", "sightLimit");
        }

        sightLimit = Math.max(sightLimit ?? Infinity, 0) / canvas.dimensions.distance * canvas.dimensions.size;

        if (this._pv_sightLimit !== sightLimit) {
            this._pv_sightLimit = sightLimit;
            this._pv_flags_updateArea = true;

            this._pv_initializeVision = true;
        }

        let daylightColor;

        if (this._pv_preview?.hasOwnProperty("daylightColor")) {
            daylightColor = this._pv_preview.daylightColor ?? "";
        } else {
            daylightColor = canvas.scene.getFlag("perfect-vision", "daylightColor") ?? "";
        }

        if (daylightColor === "") {
            daylightColor = CONFIG.Canvas.daylightColor;
        }

        daylightColor = sanitizeLightColor(daylightColor);

        let darknessColor;

        if (this._pv_preview?.hasOwnProperty("darknessColor")) {
            darknessColor = this._pv_preview.darknessColor ?? "";
        } else {
            darknessColor = canvas.scene.getFlag("perfect-vision", "darknessColor") ?? "";
        }

        if (darknessColor === "") {
            darknessColor = CONFIG.Canvas.darknessColor;
        }

        darknessColor = sanitizeLightColor(darknessColor);

        if (daylightColor !== this._pv_daylightColor || darknessColor !== this._pv_darknessColor) {
            this.channels = null;
        }

        this._pv_daylightColor = daylightColor;
        this._pv_darknessColor = darknessColor;

        // Update lighting channels
        if (darknessChanged || bgChanged || !this.channels) {
            this.channels = this._pv_channels = this._configureChannels({
                backgroundColor: foundry.utils.colorStringToHex(backgroundColor),
                darkness
            });
        }

        this._pv_darknessChanged = darknessChanged;

        let refreshVision = false;

        // Track global illumination
        const globalLight = this.hasGlobalIllumination();

        if (this.globalLight !== globalLight) {
            this.globalLight = this._pv_globalLight = globalLight;

            refreshVision = true; // TODO: initialize necessary as well?
        }

        const bkg = this.background;
        const ilm = this.illumination;
        const col = this.coloration;
        const del = this._pv_delimiter;

        // Clear currently rendered sources
        bkg.removeChildren();
        ilm.lights.removeChildren();
        col.removeChildren();
        del.removeChildren();

        if (game.user.isGM) {
            const gmVision = game.settings.get("perfect-vision", "improvedGMVision") && canvas.sight.sources.size === 0;

            ilm._pv_filter.toggled = gmVision;
            ilm._pv_filter.enabled = ilm._pv_filter === ilm.filter || gmVision;
            ilm._pv_filter.brightness = Math.clamped(game.settings.get("perfect-vision", "improvedGMVisionBrightness") ?? 0.25, 0.05, 0.95);

            this._pv_delimiter.visible = game.settings.get("perfect-vision", "delimiters");
        }

        this._animatedSources = [];

        // Tint the background color
        canvas.app.renderer.backgroundColor = this.channels.canvas.hex;

        this._pv_vision = !canvas.sight.tokenVision || canvas.sight.sources.size === 0 && game.user.isGM;

        this._pv_refreshAreas();

        // Render light sources
        for (const source of this.sources) {
            const area = this._pv_getArea(source);

            if (source._pv_area !== area) {
                source._pv_area = area;
                source._flags.lightingVersion = 0;
                source._resetUniforms.illumination = true;
            }

            // Check the active state of the light source
            const active = !source.skipRender /* Levels */ && area._pv_darknessLevel.between(source.data.darkness.min, source.data.darkness.max);

            if (source.active !== active) {
                source.active = active;
                source._pv_flags_updateArea = source._pv_flags_updateArea || active === !canvas._pv_limits.hasRegion(source.object.sourceId);

                refreshVision = true;
            }

            if (source._pv_flags_updateArea) {
                source._pv_flags_updateArea = false;

                const sourceId = source.object.sourceId;

                if (source.active && source._pv_sightLimit !== undefined) {
                    canvas._pv_limits.addRegion(sourceId, {
                        region: source._pv_los,
                        limit: source._pv_sightLimit,
                        mode: source.isDarkness ? "min": "max",
                        index: [3, source.data.z ?? (source.isDarkness ? 10 : 0), source.isDarkness]
                    });

                    this._pv_initializeVision = true;
                } else {
                    if (canvas._pv_limits.deleteRegion(sourceId)) {
                        this._pv_initializeVision = true;
                    }
                }
            }

            if (!source.active) {
                continue;
            }

            // Draw the light update
            const meshes = source.drawMeshes();

            if (meshes.background) {
                bkg.addChild(meshes.background);
            }

            if (meshes.light) {
                ilm.lights.addChild(meshes.light);
            }

            if (meshes.color) {
                col.addChild(meshes.color);
            }

            if (meshes._pv_delimiter) {
                del.addChild(meshes._pv_delimiter);
            }

            if (source.data.animation?.type) {
                this._animatedSources.push(source);
            }
        }

        if (this._pv_initializeVision) {
            this._pv_initializeVision = false;

            canvas._pv_limits.update();

            canvas.sight.initializeSources();

            refreshVision = true;
        }

        // Render sight from vision sources
        for (const source of canvas.sight.sources) {
            const area = this._pv_getArea(source);

            if (source._pv_area !== area) {
                source._pv_area = area;
                source._flags.lightingVersion = 0;
                source._resetUniforms.illumination = true;
            }

            if (source.radius <= 0) {
                continue;
            }

            const sight = source.drawVision();
            const delimiter = source._pv_drawDelimiter();

            if (sight) {
                ilm.lights.addChild(sight);
            }

            if (delimiter) {
                del.addChild(delimiter);
            }
        }

        this._pv_refreshBuffer();

        // Refresh vision if necessary
        if (refreshVision || this._pv_refreshVision) {
            this._pv_refreshVision = false;

            canvas.perception.schedule({ sight: { refresh: true } });
        }

        // Refresh audio if darkness changed
        if (this._pv_darknessChanged) {
            this._onDarknessChange(darkness, priorDarknessLevel);
            canvas.sounds._onDarknessChange(darkness, priorDarknessLevel);
        }

        // Dispatch a hook that modules can use
        Hooks.callAll("lightingRefresh", this);
    });

    patch("LightingLayer.prototype.tearDown", "WRAPPER", async function (wrapped, ...args) {
        const stage = this._pv_stage;

        stage.transform.reference = PIXI.Transform.IDENTITY;

        for (const child of stage.children) {
            child._parentID = -1;
        }

        stage.areas.removeChildren();
        stage.visions.removeChildren();
        stage.lights.removeChildren();

        this._pv_destroyArea(this);
        this._pv_areas.length = 0;

        return await wrapped(...args);
    });

    patch("AmbientLight.prototype.isVisible", "OVERRIDE", function () {
        return !this.data.hidden && canvas.lighting._pv_getDarknessLevel(this.source).between(this.config.darkness.min ?? 0, this.config.darkness.max ?? 1);
    });

    patch("AmbientSound.prototype.isAudible", "OVERRIDE", function () {
        if (this.levelsInaudible /* Levels */) {
            return false;
        }

        return !this.data.hidden && canvas.lighting._pv_getDarknessLevel(this.center).between(this.data.darkness.min ?? 0, this.data.darkness.max ?? 1);
    });
});

LightingLayer.prototype._pv_toggleGMVision = function (toggled) {
    game.settings.set("perfect-vision", "improvedGMVision", toggled ?? !game.settings.get("perfect-vision", "improvedGMVision"));
};

LightingLayer.prototype._pv_toggleDelimiters = function (toggled) {
    game.settings.set("perfect-vision", "delimiters", toggled ?? !game.settings.get("perfect-vision", "delimiters"));
};

LightingLayer.prototype._pv_drawDelimiterContainer = function () {
    const c = new PointSourceContainer();

    c.filterDelimiter = new PIXI.filters.AlphaFilter(0.5);
    c.filterDelimiter.blendMode = PIXI.BLEND_MODES.NORMAL;
    c.filterDelimiter.resolution = canvas.app.renderer.resolution;
    c.filterDelimiter.multisample = PIXI.MSAA_QUALITY.NONE;
    c.filters = [c.filterDelimiter];
    c.filterArea = canvas.app.renderer.screen;
    c.sortableChildren = true;
    c.visible = false;

    return c;
};

LightingLayer.prototype._pv_getArea = function (point) {
    let result = this;

    for (const area of this._pv_areas) {
        if (area._pv_los && !area._pv_los.containsPoint(point)) {
            continue;
        }

        if (area._pv_fov.containsPoint(point)) {
            result = area;
        }
    }

    return result;
};

LightingLayer.prototype._pv_getDarknessLevel = function (point) {
    return this._pv_getArea(point)._pv_darknessLevel ?? 0;
};

LightingLayer.prototype._pv_refreshAreas = function () {
    const sorted = [];
    const visited = {};

    const visit = area => {
        if (area === this) {
            return;
        }

        if (visited[area.id]) {
            return;
        }

        visited[area.id] = true;

        if (area._pv_active === undefined) {
            this._pv_initializeArea(area);
        }

        let parent;

        if (area._pv_preview?.hasOwnProperty("parent")) {
            parent = area._pv_preview.parent ?? "";
        } else {
            parent = area.document.getFlag("perfect-vision", "parent") ?? "";
        }

        if (parent) {
            parent = canvas.drawings.get(parent) ?? null;
        } else {
            parent = this;
        }

        area._pv_parent = parent;

        if (parent) {
            visit(parent);
        }

        sorted.push(area);
    }

    for (const drawing of canvas.scene.drawings) {
        visit(drawing.object);
    }

    this._pv_areas.length = 0;

    for (const area of sorted) {
        this._pv_updateArea(area);
    }

    this._pv_areas.sort((a, b) => a._pv_zIndex - b._pv_zIndex || a.id.localeCompare(b.id, "en"));

    this._pv_index = -1;

    if (this._pv_flags_updateArea) {
        this._pv_flags_updateArea = false;

        canvas._pv_limits.addRegion("Scene", {
            region: canvas.dimensions.rect.clone().pad(canvas.dimensions.size),
            limit: this._pv_sightLimit,
            mode: "set"
        });

        if (!canvas._pv_limits.uniformlyLimited) {
            this._pv_initializeVision = true;
        }

        this._pv_refreshVision = true;
    }

    for (let i = 0; i < this._pv_areas.length; i++) {
        const area = this._pv_areas[i];

        if (area._pv_index !== i) {
            area._pv_index = i;
            area._pv_flags_updateArea = true;

            this._pv_refreshVision = true;
        }

        if (area._pv_flags_updateArea) {
            area._pv_flags_updateArea = false;

            canvas._pv_limits.addRegion(`Drawing.${area.document.id}`, {
                region: area._pv_fov,
                mask: area._pv_los,
                limit: area._pv_sightLimit,
                mode: "set",
                index: [1, area._pv_index]
            });

            if (!canvas._pv_limits.uniformlyLimited) {
                this._pv_initializeVision = true;
            }

            this._pv_refreshVision = true;
        }
    }

    this._pv_parentIndex = -1;
    this._pv_uniformVision = true;
    this._pv_uniformGlobalLight = true;

    for (const area of this._pv_areas) {
        area._pv_parentIndex = area._pv_parent._pv_index;

        if (this._pv_vision !== area._pv_vision) {
            this._pv_uniformVision = false;
        }

        if (this._pv_globalLight !== area._pv_globalLight) {
            this._pv_uniformGlobalLight = false;
        }
    }
}

const tempPoint = new PIXI.Point();
const tempMatrix = new PIXI.Matrix();

LightingLayer.prototype._pv_updateArea = function (area) {
    const document = area.document;

    let active;

    if (area._pv_preview?.hasOwnProperty("active")) {
        active = !!area._pv_preview.active;
    } else {
        active = !!document.getFlag("perfect-vision", "active");
    }

    active = active && area._pv_parent?._pv_active;

    if (area._pv_active !== active) {
        area._pv_active = active;
        area._pv_flags_updateFOV = true;
        area._pv_flags_updateLOS = true;

        this._pv_initializeVision = true;
        this._pv_refreshVision = true;
    }

    if (!active) {
        this._pv_destroyArea(area);

        return;
    }

    if (!area.skipRender /* Levels */) {
        this._pv_areas.push(area);
    }

    let updateFOV = area._pv_flags_updateFOV;
    let updateLOS = area._pv_flags_updateLOS;

    area._pv_flags_updateFOV = false;
    area._pv_flags_updateLOS = false;

    let origin;

    if (area._pv_preview?.hasOwnProperty("origin")) {
        origin = area._pv_preview.origin ?? { x: 0.5, y: 0.5 };
    } else {
        origin = document.getFlag("perfect-vision", "origin") ?? { x: 0.5, y: 0.5 };
    }

    origin = tempPoint.set(origin.x * area.data.width, origin.y * area.data.height);

    const transform = area._pv_getTransform(tempMatrix);

    transform.apply(origin, origin);

    if (area._pv_origin?.x !== origin.x || area._pv_origin?.y !== origin.y) {
        if (!area._pv_origin) {
            area._pv_origin = new PIXI.Point();
        }

        area._pv_origin.copyFrom(origin);

        updateLOS = true;
    }

    let walls;

    if (area._pv_preview?.hasOwnProperty("walls")) {
        walls = !!area._pv_preview.walls;
    } else {
        walls = !!document.getFlag("perfect-vision", "walls");
    }

    if (area._pv_walls !== walls) {
        area._pv_walls = walls;

        updateLOS = true;
    }

    let vision;

    if (area._pv_preview?.hasOwnProperty("vision")) {
        vision = !!area._pv_preview.vision;
    } else {
        vision = !!document.getFlag("perfect-vision", "vision");
    }

    if (this._pv_vision) {
        vision = true;
    }

    if (area._pv_vision !== vision) {
        area._pv_vision = vision;

        this._pv_refreshVision = true;
    }

    if (updateFOV) {
        area._pv_fov = Region.from(area._pv_getShape(), transform);
    }

    if (updateLOS) {
        if (area._pv_walls) {
            area._pv_los = Region.from(CONFIG.Canvas.losBackend.create(area._pv_origin, { type: "light" }));
        } else {
            if (!area._pv_los) {
                updateLOS = false;
            } else {
                area._pv_los = null;
            }
        }
    }

    if (updateFOV || updateLOS) {
        area._pv_geometry = new PointSourceGeometry(area._pv_fov, area._pv_los, canvas.dimensions._pv_inset);
        area._pv_flags_updateArea = true;

        this._pv_refreshVision = true;
    }

    if (!area._pv_shader) {
        area._pv_shader = new LightingAreaShader(area);
    }

    if (!area._pv_mesh) {
        area._pv_mesh = new PointSourceMesh(area._pv_geometry, area._pv_shader);
        area._pv_mesh.blendMode = PIXI.BLEND_MODES.NORMAL_NPM;
        area._pv_mesh.colorMask.alpha = false;
    }

    let globalLight;

    if (area._pv_preview?.hasOwnProperty("globalLight")) {
        globalLight = area._pv_preview.globalLight;
    } else {
        globalLight = document.getFlag("perfect-vision", "globalLight");
    }

    if (globalLight === undefined) {
        globalLight = area._pv_parent._pv_data_globalLight;
    }

    area._pv_data_globalLight = globalLight = !!globalLight;

    let sightLimit;

    if (area._pv_preview?.hasOwnProperty("sightLimit")) {
        sightLimit = area._pv_preview.sightLimit;
    } else {
        sightLimit = document.getFlag("perfect-vision", "sightLimit");
    }

    if (sightLimit !== undefined) {
        sightLimit = Math.max(sightLimit ?? Infinity, 0) / canvas.dimensions.distance * canvas.dimensions.size;
    } else {
        sightLimit = area._pv_parent._pv_sightLimit;
    }

    if (area._pv_sightLimit !== sightLimit) {
        area._pv_sightLimit = sightLimit;
        area._pv_flags_updateArea = true;

        this._pv_initializeVision = true;
        this._pv_refreshVision = true;
    }

    let daylightColor;

    if (area._pv_preview?.hasOwnProperty("daylightColor")) {
        daylightColor = area._pv_preview.daylightColor;
    } else {
        daylightColor = document.getFlag("perfect-vision", "daylightColor");
    }

    if (daylightColor !== undefined) {
        daylightColor = daylightColor ?? "";

        if (daylightColor === "") {
            daylightColor = CONFIG.Canvas.daylightColor;
        }
    } else {
        daylightColor = area._pv_parent._pv_daylightColor;
    }

    daylightColor = sanitizeLightColor(daylightColor);

    let darknessColor;

    if (area._pv_preview?.hasOwnProperty("darknessColor")) {
        darknessColor = area._pv_preview.darknessColor;
    } else {
        darknessColor = document.getFlag("perfect-vision", "darknessColor");
    }

    if (darknessColor !== undefined) {
        darknessColor = darknessColor ?? "";

        if (darknessColor === "") {
            darknessColor = CONFIG.Canvas.darknessColor;
        }
    } else {
        darknessColor = area._pv_parent._pv_darknessColor;
    }

    darknessColor = sanitizeLightColor(darknessColor);

    if (area._pv_daylightColor !== daylightColor || area._pv_darknessColor !== darknessColor) {
        area._pv_channels = null;
    }

    area._pv_daylightColor = daylightColor;
    area._pv_darknessColor = darknessColor;

    let darkness;

    if (area._pv_preview?.hasOwnProperty("darkness")) {
        darkness = area._pv_preview.darkness;
    } else {
        darkness = document.getFlag("perfect-vision", "darkness");
    }

    if (darkness !== undefined) {
        darkness = darkness ?? 0;
    } else {
        darkness = area._pv_parent._pv_darknessLevel;
    }

    darkness = Math.clamped(darkness, 0, 1);

    if (area._pv_darknessLevel !== darkness) {
        area._pv_channels = null;

        this._pv_darknessChanged = true;
    }

    area._pv_darknessLevel = darkness;

    let saturation;

    if (area._pv_preview?.hasOwnProperty("saturation")) {
        saturation = area._pv_preview.saturation
    } else {
        saturation = document.getFlag("perfect-vision", "saturation");
    }

    if (saturation !== undefined) {
        if (saturation === null) {
            if (game.system.id === "pf2e" && canvas.sight.rulesBasedVision) {
                saturation = (0.75 - darkness) / 0.5;
            } else {
                saturation = 1 - darkness;
            }
        }
    } else {
        saturation = area._pv_parent._pv_saturationLevel;
    }

    area._pv_saturationLevel = saturation = Math.clamped(saturation, 0, 1);

    let globalLightThreshold;

    if (area._pv_preview?.hasOwnProperty("globalLightThreshold")) {
        globalLightThreshold = area._pv_preview.globalLightThreshold;
    } else {
        globalLightThreshold = document.getFlag("perfect-vision", "globalLightThreshold");
    }

    if (globalLightThreshold === undefined) {
        globalLightThreshold = area._pv_parent._pv_data_globalLightThreshold;
    }

    area._pv_data_globalLightThreshold = globalLightThreshold;

    globalLight = globalLight && (globalLightThreshold === null || area._pv_darknessLevel <= globalLightThreshold);

    if (area._pv_globalLight !== globalLight) {
        area._pv_globalLight = globalLight;

        this._pv_refreshVision = true;
    }

    if (!area._pv_channels || this._pv_bgChanged) {
        const backgroundColor = this._pv_channels.scene.hex;

        area._pv_version++;
        area._pv_channels = configureChannels({ darkness, backgroundColor, daylightColor, darknessColor });
    }

    if (area._pv_zIndex !== area.data.z) {
        area._pv_zIndex = area.data.z;

        this._pv_refreshVision = true;
    }
};

LightingLayer.prototype._pv_initializeArea = LightingLayer.prototype._pv_destroyArea = function (area) {
    area._pv_active = false;
    area._pv_index = 0;
    area._pv_parent = null;
    area._pv_parentIndex = null;
    area._pv_origin = null;
    area._pv_walls = false;
    area._pv_vision = false;
    area._pv_fov = null;
    area._pv_los = null;
    area._pv_geometry = null;

    if (area._pv_shader) {
        area._pv_shader.destroy();
    }

    area._pv_shader = null;

    if (area._pv_mesh) {
        area._pv_mesh.destroy();
    }

    area._pv_mesh = null;
    area._pv_globalLight = false;
    area._pv_sightLimit = Infinity;
    area._pv_daylightColor = 0;
    area._pv_darknessColor = 0;
    area._pv_darknessLevel = 0;
    area._pv_saturationLevel = 0;
    area._pv_channels = undefined;
    area._pv_version = 0;
    area._pv_zIndex = 0;
    area._pv_data_globalLight = false;
    area._pv_data_globalLightThreshold = null;
    area._pv_flags_updateFOV = true;
    area._pv_flags_updateLOS = true;
    area._pv_flags_updateArea = true;

    if (area === canvas.lighting) {
        if (canvas._pv_limits.deleteRegion("Scene")) {
            canvas.lighting._pv_initializeVision = true;
        }
    } else {
        if (canvas._pv_limits.deleteRegion(`Drawing.${area.document.id}`)) {
            canvas.lighting._pv_initializeVision = true;
        }
    }
};

function invalidateBuffer(baseTexture) {
    if (baseTexture.resource?.source?.tagName === "VIDEO") {
        canvas._pv_showTileVideoWarning();
    }

    this.invalidate(true);
}

LightingLayer.prototype._pv_refreshBuffer = function () {
    const buffer = this._pv_buffer;
    const stage = this._pv_stage;
    const channels = this._pv_channels;
    const textures = buffer.textures;

    textures[0].baseTexture.clearColor[0] = this._pv_vision ? 1 : 0;
    textures[0].baseTexture.clearColor[1] = this._pv_vision || this._pv_globalLight ? 1 : 0;
    textures[1].baseTexture.clearColor[0] = this._pv_darknessLevel;
    textures[1].baseTexture.clearColor[1] = this._pv_saturationLevel;
    textures[2].baseTexture.clearColor.set(channels.background.rgb);

    const { areas, visions, lights, roofs, baseTextures } = stage;

    areas.removeChildren();
    visions.removeChildren();
    lights.removeChildren();
    roofs.removeChildren().forEach(sprite => sprite.destroy());

    for (const baseTexture of baseTextures) {
        baseTexture.off("update", invalidateBuffer, buffer);
    }

    baseTextures.length = 0;

    for (const area of this._pv_areas) {
        const mesh = area._pv_drawMesh();

        if (!mesh) {
            continue;
        }

        areas.addChild(mesh);
    }

    {
        const minFOV = [];

        for (const source of canvas.sight.sources) {
            const mesh = source._pv_drawMesh();

            if (!mesh) {
                continue;
            }

            visions.addChild(mesh);

            minFOV.push(source.x, source.y, source._pv_minRadius);
        }

        const minFOVMesh = stage.minFOV;
        const minFOVGeometry = minFOVMesh.geometry;

        minFOVGeometry.buffers[1].update(minFOV);
        minFOVGeometry.instanceCount = minFOV.length / 3;
        minFOVMesh.visible = minFOVGeometry.instanceCount > 0;
    }

    for (const source of this.sources) {
        if (!source.active) {
            continue;
        }

        const mesh = source._pv_drawMesh();

        if (!mesh) {
            continue;
        }

        lights.addChild(mesh);

        if (mesh.occlusionObjects) {
            for (const occlusionTile of mesh.occlusionObjects) {
                if (occlusionTile.destroyed || !occlusionTile.visible || !occlusionTile.renderable || occlusionTile.worldAlpha <= 0) {
                    continue;
                }

                if (!occlusionTile.geometry.bounds.intersects(source._pv_geometry.bounds)) {
                    continue;
                }

                occlusionTile.texture.baseTexture.on("update", invalidateBuffer, buffer);

                baseTextures.push(occlusionTile.texture.baseTexture);
            }
        }
    }

    if (canvas.foreground.displayRoofs) {
        for (const roof of canvas.foreground.roofs) {
            if (roof.occluded) {
                continue;
            }

            const sprite = roof._pv_createSprite();

            if (!sprite) {
                continue;
            }

            sprite.tint = 0x000000;
            sprite.texture.baseTexture.on("update", invalidateBuffer, buffer);

            baseTextures.push(sprite.texture.baseTexture);

            roofs.addChild(sprite);
        }
    }

    buffer.invalidate();
};

LightingLayer.prototype._pv_drawMask = function (fov, los) {
    fov.draw({ hole: !this._pv_vision && !this._pv_globalLight });
    los.draw({ hole: !this._pv_vision });
};

Drawing.prototype._pv_drawMesh = function () {
    const mesh = this._pv_mesh;
    const shader = this._pv_shader;

    if (!shader) {
        return null;
    }

    const uniforms = shader.uniforms;
    const channels = this._pv_channels;

    mesh.geometry = this._pv_geometry;
    mesh.shader = shader;

    uniforms.uLos = this._pv_vision ? 1 : 0;
    uniforms.uFov = this._pv_vision || this._pv_globalLight ? 1 : 0;
    uniforms.uDarknessLevel = this._pv_darknessLevel;
    uniforms.uSaturationLevel = this._pv_saturationLevel;
    uniforms.uColorBackground.set(channels.background.rgb);

    return mesh;
};

Drawing.prototype._pv_drawMask = function (fov, los, inset = false) {
    const geometry = this._pv_geometry;
    const segments = geometry.segments;

    fov.pushMask({ geometry: segments.fov });

    if (inset && (this._pv_vision || this._pv_globalLight)) {
        fov.pushMask({ geometry: segments.edges, hole: true });
    }

    los.pushMask({ geometry: segments.fov });

    if (inset && this._pv_vision) {
        los.pushMask({ geometry: segments.edges, hole: true });
    }

    if (this._pv_los) {
        fov.draw({ geometry: segments.los, hole: !this._pv_vision && !this._pv_globalLight });
        los.draw({ geometry: segments.los, hole: !this._pv_vision });
    } else {
        fov.draw({ hole: !this._pv_vision && !this._pv_globalLight });
        los.draw({ hole: !this._pv_vision });
    }

    fov.popMasks();
    los.popMasks();
};

function configureChannels({
    darkness,
    backgroundColor,
    daylightColor = CONFIG.Canvas.daylightColor,
    darknessColor = CONFIG.Canvas.darknessColor,
    darknessLightPenalty = CONFIG.Canvas.darknessLightPenalty,
    dark = CONFIG.Canvas.lightLevels.dark,
    black = 0.5,
    dim = CONFIG.Canvas.lightLevels.dim,
    bright = CONFIG.Canvas.lightLevels.bright
} = {}) {
    darkness = darkness ?? canvas.scene.data.darkness;
    backgroundColor = backgroundColor ?? canvas.backgroundColor;

    const channels = { daylight: {}, darkness: {}, scene: {}, canvas: {}, background: {}, dark: {}, black: {}, bright: {}, dim: {} };

    channels.daylight.rgb = canvas.scene.data.tokenVision ? foundry.utils.hexToRGB(daylightColor) : [1.0, 1.0, 1.0];
    channels.daylight.hex = foundry.utils.rgbToHex(channels.daylight.rgb);
    channels.darkness.level = darkness;
    channels.darkness.rgb = foundry.utils.hexToRGB(darknessColor);
    channels.darkness.hex = foundry.utils.rgbToHex(channels.darkness.rgb);
    channels.scene.rgb = foundry.utils.hexToRGB(backgroundColor);
    channels.scene.hex = foundry.utils.rgbToHex(channels.scene.rgb);
    channels.canvas.rgb = channels.darkness.rgb.map((c, i) => ((1 - darkness) + darkness * c) * channels.scene.rgb[i]);
    channels.canvas.hex = foundry.utils.rgbToHex(channels.canvas.rgb);
    channels.background.rgb = channels.darkness.rgb.map((c, i) => darkness * c + (1 - darkness) * channels.daylight.rgb[i]);
    channels.background.hex = foundry.utils.rgbToHex(channels.background.rgb);
    channels.dark.rgb = foundry.utils.hexToRGB(CONFIG.Canvas.darknessColor).map(c => (1 + dark) * c);
    channels.dark.hex = foundry.utils.rgbToHex(channels.dark.rgb);
    channels.black.rgb = channels.dark.rgb.map(c => black * c);
    channels.black.hex = foundry.utils.rgbToHex(channels.black.rgb);
    channels.bright.rgb = [1, 1, 1].map((c, i) => Math.max(bright * (1 - darknessLightPenalty * darkness) * c, channels.background.rgb[i]));
    channels.bright.hex = foundry.utils.rgbToHex(channels.bright.rgb);
    channels.dim.rgb = channels.bright.rgb.map((c, i) => dim * c + (1 - dim) * channels.background.rgb[i]);
    channels.dim.hex = foundry.utils.rgbToHex(channels.dim.rgb);

    return channels;
}

function sanitizeLightColor(color) {
    if (typeof color === "string") {
        color = foundry.utils.colorStringToHex(color);
    }

    const x = [(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF].map(x => Math.max(x, 0xF));
    return (x[0] << 16) + (x[1] << 8) + x[2];
}

Hooks.on("updateScene", (scene, change, options, userId) => {
    if (!scene.isView || !("flags" in change && ("perfect-vision" in change.flags || "-=perfect-vision" in change.flags) || "-=flags" in change)) {
        return;
    }

    canvas.perception.schedule({
        lighting: { initialize: true, refresh: true },
        sight: { initialize: true, refresh: true },
        foreground: { refresh: true },
    });
});

Hooks.on("updateToken", (document, change, options, userId, arg) => {
    const scene = document.parent;

    if (!scene?.isView || !("flags" in change && ("perfect-vision" in change.flags || "-=perfect-vision" in change.flags) || "-=flags" in change)) {
        return;
    }

    const token = document.object;

    if (token) {
        token.updateSource({ defer: true });

        canvas.perception.schedule({
            lighting: { refresh: true },
            sight: { refresh: true, forceUpdateFog: token.hasLimitedVisionAngle }
        });
    }
});

class IlluminationContainerFilter extends PIXI.Filter {
    static vertexSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_VERTEX} float;

        attribute vec2 aVertexPosition;

        uniform mat3 projectionMatrix;
        uniform vec4 inputSize;
        uniform vec4 outputFrame;
        uniform vec2 screenDimensions;

        varying vec2 vTextureCoord;
        varying vec2 vScreenCoord;

        void main() {
            vec3 position = vec3(aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy, 1.0);

            gl_Position = vec4((projectionMatrix * position).xy, 0.0, 1.0);

            vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
            vScreenCoord = position.xy / screenDimensions;
        }`;

    static fragmentSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_FRAGMENT} float;

        varying vec2 vTextureCoord;
        varying vec2 vScreenCoord;

        uniform sampler2D uSampler;
        uniform sampler2D uDarknessLevel;
        uniform float uAlpha;
        uniform bool uToggled;
        uniform float uBrightness;

        void main() {
            float darkness = texture2D(uDarknessLevel, vScreenCoord).r;
            float brightness = uToggled ? uBrightness * darkness : 0.0;

            gl_FragColor = vec4(texture2D(uSampler, vTextureCoord).rgb * (1.0 - brightness) + brightness, 1.0) * uAlpha;
        }`;

    constructor(alpha = 1) {
        super(IlluminationContainerFilter.vertexSrc, IlluminationContainerFilter.fragmentSrc, {
            screenDimensions: new Float32Array(2),
            uAlpha: alpha,
            uToggled: false,
            uBrightness: 0.25
        });
    }

    get alpha() {
        return this.uniforms.uAlpha;
    }

    set alpha(value) {
        this.uniforms.uAlpha = value;
    }

    get toggled() {
        return this.uniforms.uToggled;
    }

    set toggled(value) {
        this.uniforms.uToggled = value;
    }

    get brightness() {
        return this.uniforms.uBrightness;
    }

    set brightness(value) {
        this.uniforms.uBrightness = value;
    }

    apply(filterManager, input, output, clearMode, currentState) {
        const { width, height } = canvas.app.renderer.screen;
        const screenDimensions = this.uniforms.screenDimensions;

        screenDimensions[0] = width;
        screenDimensions[1] = height;

        this.uniforms.uDarknessLevel = canvas.lighting._pv_buffer.textures[1];

        super.apply(filterManager, input, output, clearMode, currentState);
    }
}

class IlluminationBackgroundShader extends PIXI.Shader {
    static vertexSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_VERTEX} float;

        attribute vec2 aVertexPosition;

        uniform mat3 projectionMatrix;
        uniform vec2 screenDimensions;

        varying vec2 vScreenCoord;

        void main() {
            gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

            vScreenCoord = aVertexPosition / screenDimensions;
        }`;

    static fragmentSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_FRAGMENT} float;

        varying vec2 vScreenCoord;

        uniform sampler2D uColorBackground;

        void main() {
            gl_FragColor = texture2D(uColorBackground, vScreenCoord);
        }`;

    static get program() {
        if (!this._program) {
            this._program = PIXI.Program.from(this.vertexSrc, this.fragmentSrc);
        }

        return this._program;
    }

    static get instance() {
        if (!this._instance) {
            this._instance = new this();
        }

        return this._instance;
    }

    constructor() {
        super(IlluminationBackgroundShader.program, {
            screenDimensions: new Float32Array(2)
        });
    }

    update() {
        const { width, height } = canvas.app.renderer.screen;
        const screenDimensions = this.uniforms.screenDimensions;

        screenDimensions[0] = width;
        screenDimensions[1] = height;

        this.uniforms.uColorBackground = canvas.lighting._pv_buffer.textures[2];
    }
}

class LightingAreaShader extends PIXI.Shader {
    static vertexSrc = `\
        #version 300 es

        precision ${PIXI.settings.PRECISION_VERTEX} float;

        layout(location = 0) in vec2 aVertexPosition;
        layout(location = 1) in lowp float aVertexDepth;

        uniform mat3 projectionMatrix;
        uniform mat3 translationMatrix;

        void main() {
            gl_Position = vec4((projectionMatrix * (translationMatrix * vec3(aVertexPosition, 1.0))).xy, aVertexDepth, 1.0);
        }`;

    static fragmentSrc = `\
        #version 300 es

        precision ${PIXI.settings.PRECISION_FRAGMENT} float;

        uniform float uLos;
        uniform float uFov;
        uniform float uDarknessLevel;
        uniform float uSaturationLevel;
        uniform vec3 uColorBackground;

        layout(location = 0) out vec4 textures[3];

        void main() {
            float alpha = smoothstep(0.0, 1.0, gl_FragCoord.z);

            textures[0] = vec4(uLos, uFov, 0.0, alpha);
            textures[1] = vec4(uDarknessLevel, uSaturationLevel, 0.0, alpha);
            textures[2] = vec4(uColorBackground, alpha);
        }`;


    static get program() {
        if (!this._program) {
            this._program = PIXI.Program.from(this.vertexSrc, this.fragmentSrc);
        }

        return this._program;
    }

    constructor(area) {
        super(LightingAreaShader.program, {
            uLos: 0,
            uFov: 0,
            uDarknessLevel: 0,
            uSaturationLevel: 0,
            uColorBackground: new Float32Array(3)
        });

        this.area = area;
    }
}

class PointSourceContainer extends PIXI.Container {
    render(renderer) {
        const gl = renderer.gl;

        renderer.batch.flush();

        // TODO: setting depthRange & depthFunc is probably unnecessary
        gl.depthRange(0, 1);

        super.render(renderer);

        renderer.batch.flush();

        gl.depthFunc(gl.LESS);
    }
}

class ColorMaskContainer extends PIXI.Container {
    constructor(red, green, blue, alpha) {
        super();

        this._colorMaskRed = red;
        this._colorMaskGreen = green;
        this._colorMaskBlue = blue;
        this._colorMaskAlpha = alpha;
    }
    render(renderer) {
        if (this.children.length === 0) {
            return;
        }

        renderer.batch.flush();

        const gl = renderer.gl;

        gl.colorMask(this._colorMaskRed, this._colorMaskGreen, this._colorMaskBlue, this._colorMaskAlpha);

        super.render(renderer);

        renderer.batch.flush();

        gl.colorMask(true, true, true, true);
    }
}

class DrawBuffersContainer extends PIXI.Container {
    constructor(...buffers) {
        super();

        this._drawBuffers = Array.from(buffers);
    }

    render(renderer) {
        if (this.children.length === 0) {
            return;
        }

        renderer.batch.flush();

        renderer.gl.drawBuffers(this._drawBuffers);

        super.render(renderer);

        renderer.batch.flush();
    }
}

class MinFOVShader extends PIXI.Shader {
    static vertexSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_VERTEX} float;

        attribute vec2 aVertexPosition;
        attribute vec3 aCenterRadius;

        uniform mat3 projectionMatrix;
        uniform mat3 translationMatrix;

        varying vec3 vCoord;

        void main() {
            vec2 center = aCenterRadius.xy;
            float radius = aCenterRadius.z;
            vec2 local = aVertexPosition * radius;

            gl_Position = vec4((projectionMatrix * (translationMatrix * vec3(center + local, 1.0))).xy, 0.0, 1.0);

            vCoord = vec3(local, radius);
        }`;

    static fragmentSrc = `\
        #version 100

        precision ${PIXI.settings.PRECISION_FRAGMENT} float;

        uniform float uSmoothness;

        varying vec3 vCoord;

        void main() {
            gl_FragColor = vec4(0.0, 1.0 - smoothstep(vCoord.z - uSmoothness, vCoord.z, length(vCoord.xy)), 0.0, 0.0);
        }`;

    static get program() {
        if (!this._program) {
            this._program = PIXI.Program.from(this.vertexSrc, this.fragmentSrc);
        }

        return this._program;
    }

    static get instance() {
        if (!this._instance) {
            this._instance = new this();
        }

        return this._instance;
    }

    constructor() {
        super(MinFOVShader.program, { uSmoothness: 0 });
    }

    update() {
        this.uniforms.uSmoothness = canvas.dimensions._pv_inset;
    }
}
