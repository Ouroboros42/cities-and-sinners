import { Logger } from "../../utils/logger.js";

function generateDistanceFunction(functionName, n, k) {
    const toFloatLiteral = x => {
        x = Math.fround(x);

        if (Math.abs(x) < 1e-8) {
            return "0.0";
        }

        for (let n = 17; n > 0; n--) {
            if (x !== Math.fround(x.toFixed(n))) {
                return x.toFixed(n + 1);
            }
        }

        return x.toFixed(1);
    };

    functionName = functionName.replace(/%n%/gm, n).replace(/%k%/gm, k);

    if (k === 1) {
        return `\
        float ${functionName}(vec2 p, vec2 q, float r) {
            vec2 v = p - q;
            float a = atan(v.y, v.x) - r + ${n % 4 ? (n % 2 ? toFloatLiteral(Math.PI / 2) : "0.0") : toFloatLiteral(Math.PI / n)};
            return ${toFloatLiteral(Math.hypot(1, Math.tan(Math.PI / n)))} * cos(a - (floor(a * ${toFloatLiteral(n / (Math.PI * 2))}) + 0.5) * ${toFloatLiteral(Math.PI * 2 / n)}) * length(v);
        }`;
    }

    const a = Math.PI * 2 / n;
    const p = foundry.utils.lineLineIntersection(
        { x: 1, y: 0 },
        { x: Math.cos(a * k), y: Math.sin(a * k) },
        { x: Math.cos(a), y: Math.sin(a) },
        { x: Math.cos(a * (1 - k)), y: Math.sin(a * (1 - k)) }
    );
    const r = Math.hypot(p.x, p.y);
    const c = Math.cos(Math.PI / n);
    const d = r * (c * c - 1);
    const s = (r * c - 1) / d;
    const t = (r - c) / d;

    return `\
        float ${functionName}(vec2 p, vec2 q, float r) {
            vec2 v = p - q;
            float a = atan(v.y, v.x) - r + ${n % 4 ? (n % 2 ? toFloatLiteral(Math.PI / 2) : "0.0") : toFloatLiteral(Math.PI / n)};
            float k = a * ${toFloatLiteral(n / (Math.PI * 2))};
            return (${toFloatLiteral(s)} * cos(a - (floor(k) + 0.5) * ${toFloatLiteral(Math.PI * 2 / n)}) - ${toFloatLiteral(t)} * cos(a - (floor(k + 0.5)) * ${toFloatLiteral(Math.PI * 2 / n)})) * length(v);
        }`;
}

const OCCLUSION_MASK = `\
uniform sampler2D pv_occlusionMaskSampler;
uniform vec4 pv_occlusionMaskFrame;

float pv_occlusionMaskAlpha(vec2 worldPosition) {
    return texture(pv_occlusionMaskSampler, (worldPosition - pv_occlusionMaskFrame.xy) / pv_occlusionMaskFrame.zw).r;
}
`;

const DISTANCE_FUNCTIONS = [[3, 1], [4, 1], [5, 1], [5, 2], [6, 1], [6, 2]];

const SHAPES_AND_DISTANCE = `\
#ifdef PV_LIGHT_MASK
uniform int pv_shape;
uniform float pv_rotation;

float pv_distance_circle(vec2 p, vec2 q, float r) {
    return distance(p, q);
}

${DISTANCE_FUNCTIONS.map(([n, k]) => generateDistanceFunction("pv_distance_%n%_%k%", n, k)).join("\n\n")}

float pv_distance(vec2 p, vec2 q) {
    float r = pv_rotation;
    float d;
    switch (pv_shape) {
        case 0: d = pv_distance_circle(p, q, r); break;
${DISTANCE_FUNCTIONS.map(([n, k], i) => `        case ${i + 1}: d = pv_distance_${n}_${k}(p, q, r); break;`).join("\n")}
    }
    return d;
}
#else
#define pv_distance distance
#endif
`;

Logger.debug("Patching AdaptiveLightingShader.vertexShader (OVERRIDE)");

AdaptiveLightingShader.vertexShader = `\
#version 300 es

precision ${PIXI.settings.PRECISION_VERTEX} float;

/* Patched by Perfect Vision */

layout(location = 0) in vec2 aVertexPosition;
layout(location = 1) in lowp float aVertexDepth;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;

void main() {
    gl_Position = vec4((projectionMatrix * (translationMatrix * vec3(aVertexPosition, 1.0))).xy, aVertexDepth, 1.0);
}`;

Logger.debug("Patching AdaptiveLightingShader.prototype.update (ADDED)");

AdaptiveLightingShader.prototype.update = function (renderer, mesh) {
    const uniforms = this.uniforms;

    uniforms.translationMatrixInverse = mesh.worldTransformInverse.toArray(true);

    const textures = canvas.lighting._pv_buffer.textures;

    // TODO: move elsewhere?
    uniforms.pv_sampler1 = textures[0];
    uniforms.pv_sampler2 = textures[1];
    uniforms.pv_colorBackgroundSampler = textures[2];

    // TODO
    const occlusionMaskFrame = uniforms.pv_occlusionMaskFrame;
    const occlusionMaskTexture = uniforms.pv_occlusionMaskSampler;
    const occlusionMaskTextureFilterFrame = occlusionMaskTexture.filterFrame;

    if (occlusionMaskTextureFilterFrame) {
        occlusionMaskFrame[0] = occlusionMaskTextureFilterFrame.x;
        occlusionMaskFrame[1] = occlusionMaskTextureFilterFrame.y;
        occlusionMaskFrame[2] = occlusionMaskTextureFilterFrame.width;
        occlusionMaskFrame[3] = occlusionMaskTextureFilterFrame.height;
    } else {
        occlusionMaskFrame[0] = 0;
        occlusionMaskFrame[1] = 0;
        occlusionMaskFrame[2] = occlusionMaskTexture.width;
        occlusionMaskFrame[3] = occlusionMaskTexture.height;
    }
};

Logger.debug("Patching AdaptiveLightingShader.prototype.occlusionMask (ADDED)");

Object.defineProperty(AdaptiveLightingShader.prototype, "occlusionMask", {
    get() {
        return this.uniforms.pv_occlusionMaskSampler;
    },
    set(value) {
        this.uniforms.pv_occlusionMaskSampler = value ?? PIXI.Texture.EMPTY;
    }
});

export class DelimiterShader extends AdaptiveLightingShader {
    static fragmentShader = `\
    #version 300 es\n

    /* Patched by Perfect Vision */

    precision ${PIXI.settings.PRECISION_FRAGMENT} float;

    uniform bool darkness;
    uniform float ratio;
    uniform vec2 screenDimensions;

    uniform ${PIXI.settings.PRECISION_VERTEX} vec4 viewportFrame;
    uniform ${PIXI.settings.PRECISION_VERTEX} mat3 projectionMatrixInverse;
    uniform ${PIXI.settings.PRECISION_VERTEX} mat3 translationMatrix;
    uniform ${PIXI.settings.PRECISION_VERTEX} mat3 translationMatrixInverse;

    uniform vec2 pv_origin;
    uniform float pv_radius;
    uniform float pv_smoothness;
    uniform bool pv_sight;
    uniform sampler2D pv_sampler1;
    uniform sampler2D pv_sampler2;

    layout(location = 0) out vec4 pv_fragColor;

    %OCCLUSION_MASK%
    ${OCCLUSION_MASK}

    %LIGHT_MASK%
    ${SHAPES_AND_DISTANCE}

    %PF2E_RULES_BASED_VISION%

    void main() {
        ${PIXI.settings.PRECISION_VERTEX} vec3 worldPosition = projectionMatrixInverse * vec3(((gl_FragCoord.xy - viewportFrame.xy) / viewportFrame.zw) * 2.0 - 1.0, 1.0);
        ${PIXI.settings.PRECISION_VERTEX} vec2 localPosition = (translationMatrixInverse * worldPosition).xy;

        vec2 vSamplerUvs = worldPosition.xy / screenDimensions;

        float alpha = smoothstep(0.0, 1.0, gl_FragCoord.z);

        #ifdef PV_OCCLUSION_MASK
        alpha = min(alpha, pv_occlusionMaskAlpha(worldPosition.xy));
        #endif

        if (!darkness) {
            float dist = pv_distance(localPosition, pv_origin);

            float brightness = smoothstep(
                pv_radius * ratio + pv_smoothness * (dist / pv_radius),
                pv_radius * ratio - pv_smoothness * (1.0 - dist / pv_radius),
                dist
            );

            vec4 v = texture(pv_sampler1, vSamplerUvs);

            #ifdef PF2E_RULES_BASED_VISION
            vec4 w = texture(pv_sampler2, vSamplerUvs);
            float darknessLevel = w.r;
            #endif

            if (!pv_sight) {
                #ifdef PF2E_RULES_BASED_VISION
                float boost = min(w.a, clamp((darknessLevel - 0.25) / 0.5, 0.0, 1.0));
                #else
                float boost = texture(pv_sampler2, vSamplerUvs).a;
                #endif

                brightness = max(brightness, boost);
            } else {
                alpha = min(alpha, 1.0 - v.b);

                #ifdef PF2E_RULES_BASED_VISION
                alpha = min(alpha, clamp((darknessLevel - 0.25) / 0.5, 0.0, 1.0));
                #endif
            }

            vec2 point = (translationMatrix * vec3(localPosition.xy, 0.0)).xy / 3.0;

            alpha = min(alpha, (sin(point.x) * sin(point.y)) * 4.0 - mix(3.0, 2.0, brightness));
            alpha = min(alpha, min(v.r, v.g));

            pv_fragColor = vec4(brightness * 0.5 + 0.5) * alpha;
        } else {
            // TODO: proper delimiter for dark light sources
            pv_fragColor = vec4(0.0, 0.0, 0.0, alpha);
        }
    }`;

    static defaultUniforms = {
        ratio: 0.5,
        darkness: false,
    };
}

function stashComments(source, comments) {
    return source.replace(/(?:\/\*[\s\S]*?\*\/)|(?:\/\/.*)/gm, (comment) => {
        comments.push(comment)

        return `%comment-${comments.length - 1}%`;
    });
}

function unstashComments(source, comments) {
    source = source.replace(/%comment-(\d+)%/gm, (_, i) => {
        return comments[parseInt(i, 10)];
    });

    comments.length = 0;

    return source;
}

function replace(source, searchValue, replaceValue) {
    const comments = [];

    source = stashComments(source, comments);
    source = source.replace(searchValue, replaceValue);
    source = unstashComments(source, comments);

    return source;
}

function removeVariable(source, variable, constant = "/* Removed by Perfect Vision */") {
    return replace(source,
        new RegExp(`(^|\\W)((?:uniform|varying|in)\\s+([^;]+?)\\s+(${variable})\\s*;)`, "gm"),
        `$1
         /* Patched by Perfect Vision */
         /* $2 */
         #define $4 (${constant})
         /* ------------------------- */\n\n`
    );
}

function replaceFunction(source, name, body) {
    return replace(
        source,
        new RegExp(`((?:^|\\s)\\w+\\s+)(${name})\\s*(\\([^)]*?\\))`, "gm"),
        `/* Patched by Perfect Vision */\n$1$2$3 {${body}}\n$1_pv_unused_${name}$3`
    );
}

function wrap(source, variables, code) {
    const comments = [];
    const defintions = [];

    source = stashComments(source, comments);

    let i = 0;

    for (const match of source.matchAll(/(?:^|\W)_pv_wrapped_(\d+)(?:$|\W)/gm)) {
        i = Math.max(i, parseInt(match[1], 10) + 1);
    }

    source = source.replace(
        new RegExp(`(^|\\W)((uniform|varying|in)\\s+([^;]+?)\\s+(${variables.join("|")})\\s*;)`, "gm"),
        (...args) => {
            defintions.push(args[2]);

            if (args[3] === "uniform") {
                return `${args[1]}
                        /* Patched by Perfect Vision */
                        %defintion-${defintions.length - 1}%
                        ${args[4]} _pv_${args[5]};
                        /* ------------------------- */\n\n`;
            } else {
                return `${args[1]}
                        /* Patched by Perfect Vision */
                        /* %defintion-${defintions.length - 1}% */
                        ${args[4]} ${args[5]};
                        /* ------------------------- */\n\n`;
            }
        }
    );
    source = source.replace(/(^|\W)void\s+main\s*\(\s*\)/gm,
        i === 0 ?
            `$1void /* main */ _pv_wrapped_${i} /* Patched by Perfect Vision */ ()` :
            `$1void _pv_wrapped_${i}()`);
    source += "\n\n/* Patched by Perfect Vision */\n\n";
    source += code;
    source += "\n\n/* ------------------------- */\n\n";
    source = source.replace(new RegExp(`(^|\\W)(${variables.join("|")})($|\\W)`, "gm"), "$1_pv_$2$3");
    source = source.replace(/%defintion-(\d+)%/gm, (_, i) => {
        return defintions[parseInt(i, 10)];
    });
    source = source.replace(/%wrapped%/gi, `_pv_wrapped_${i}`)
    source = source.replace(new RegExp(`%(?:_pv_)?(${variables.join("|")})%`, "g"), "$1");
    source = unstashComments(source, comments);

    return source;
}

const keywords300es = new RegExp(
    `(^|\\W)(${[
        "layout",
        "centroid",
        "smooth",
        "case",
        "mat2x2",
        "mat2x3",
        "mat2x4",
        "mat3x2",
        "mat3x3",
        "mat3x4",
        "mat4x2",
        "mat4x3",
        "mat4x4",
        "uvec2",
        "uvec3",
        "uvec4",
        "samplerCubeShadow",
        "sampler2DArray",
        "sampler2DArrayShadow",
        "isampler2D",
        "isampler3D",
        "isamplerCube",
        "isampler2DArray",
        "usampler2D",
        "usampler3D",
        "usamplerCube",
        "usampler2DArray",
        "coherent",
        "restrict",
        "readonly",
        "writeonly",
        "resource",
        "atomic_uint",
        "noperspective",
        "patch",
        "sample",
        "subroutine",
        "common",
        "partition",
        "active",
        "filter",
        "image1D",
        "image2D",
        "image3D",
        "imageCube",
        "iimage1D",
        "iimage2D",
        "iimage3D",
        "iimageCube",
        "uimage1D",
        "uimage2D",
        "uimage3D",
        "uimageCube",
        "image1DArray",
        "image2DArray",
        "iimage1DArray",
        "iimage2DArray",
        "uimage1DArray",
        "uimage2DArray",
        "image1DShadow",
        "image2DShadow",
        "image1DArrayShadow",
        "image2DArrayShadow",
        "imageBuffer",
        "iimageBuffer",
        "uimageBuffer",
        "sampler1DArray",
        "sampler1DArrayShadow",
        "isampler1D",
        "isampler1DArray",
        "usampler1D",
        "usampler1DArray",
        "isampler2DRect",
        "usampler2DRect",
        "samplerBuffer",
        "isamplerBuffer",
        "usamplerBuffer",
        "sampler2DMS",
        "isampler2DMS",
        "usampler2DMS",
        "sampler2DMSArray",
        "isampler2DMSArray",
        "usampler2DMSArray",
    ].join("|")})($|\\W)`, "gm"
);

const DIST_SMOOTHSTEP = `smoothstep(
    pv_radius * ratio - (gradual ? pv_radius * PV_GRADUAL_SMOOTHNESS : pv_smoothness) * (1.0 - pv_dist / pv_radius),
    pv_radius * ratio + (gradual ? pv_radius * PV_GRADUAL_SMOOTHNESS : pv_smoothness) * (pv_dist / pv_radius),
    pv_dist)`;

Logger.debug("Patching AdaptiveLightingShader.create (OVERRIDE)");

const create = AdaptiveLightingShader.create;

AdaptiveLightingShader.create = function (defaultUniforms) {
    if (!this.hasOwnProperty("_pv_patched")) {
        this._pv_patched = true;

        if (this.hasOwnProperty("fragmentShader")) {
            Logger.debug("Patching %s.fragmentShader (WRAPPER)", this.name);

            this._pv_originalFragmentShader = this.fragmentShader;

            let type;

            if (this === AdaptiveBackgroundShader || this.prototype instanceof AdaptiveBackgroundShader) {
                type = AdaptiveBackgroundShader;
            } else if (this === DelimiterShader || this.prototype instanceof DelimiterShader) {
                type = DelimiterShader;
            } else if (this === AdaptiveIlluminationShader || this.prototype instanceof AdaptiveIlluminationShader) {
                type = AdaptiveIlluminationShader;
            } else if (this === AdaptiveColorationShader || this.prototype instanceof AdaptiveColorationShader) {
                type = AdaptiveColorationShader;
            } else {
                type = AdaptiveLightingShader;
            }

            if (type !== DelimiterShader) {
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(#version (?:100|300\s+es))\s*/gm,
                    "$1/* $2 */ /* --- removed --- */ /* Patched by Perfect Vision */"
                );
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(precision\s+(lowp|mediump|highp) float\s*;)/gm,
                    "$1/* $2 */ /* --- removed --- */ /* Patched by Perfect Vision */"
                );
                this.fragmentShader = removeVariable(this.fragmentShader, "useFov", "false");
                this.fragmentShader = replaceFunction(this.fragmentShader, "switchColor", `
                    return mix(innerColor, outerColor, ${DIST_SMOOTHSTEP});
                `);
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)vec3\s+finalColor($|\W)/gm,
                    "$1/* vec3 */ finalColor /* Patched by Perfect Vision */$2"
                );
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)vec4\s+baseColor\s*=\s*texture2D\s*\(\s*uBkgSampler\s*,\s*vSamplerUvs\s*\)($|\W)/gm,
                    "$1/* vec4 */ baseColor = pv_unpremultiply(texture2D(uBkgSampler, vSamplerUvs)) /* Patched by Perfect Vision */$2"
                );
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(smoothstep\s*\(\s*ratio\s*\*\s*\(\s*gradual\s*\?\s*0\.\d+\s*:\s*0\.\d+\s*\)\s*,\s*ratio\s*\*\s*\(\s*gradual\s*\?\s*1\.\d+\s*:\s*1\.\d+\s*\)\s*,\s*1.0\s*-\s*dist\s*\))($|\W)/gm,
                    `$1/* $2 */ (1.0 - ${DIST_SMOOTHSTEP}) /* Patched by Perfect Vision */$3`
                );
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(smoothstep\s*\(\s*ratio\s*\*\s*\(\s*gradual\s*\?\s*1\.\d+\s*:\s*1\.\d+\s*\)\s*,\s*ratio\s*\*\s*\(\s*gradual\s*\?\s*0\.\d+\s*:\s*0\.\d+\s*\)\s*,\s*dist\s*\))($|\W)/gm,
                    `$1/* $2 */ (1.0 - ${DIST_SMOOTHSTEP}) /* Patched by Perfect Vision */$3`
                );

                if (type === AdaptiveIlluminationShader) {
                    this.fragmentShader = wrap(this.fragmentShader, ["ratio", "colorBackground", "colorDim", "colorBright"], `\
                        uniform bool pv_sight;
                        uniform float pv_luminosity;
                        uniform sampler2D pv_sampler2;
                        uniform sampler2D pv_colorBackgroundSampler;

                        const vec3 pv_lightLevels = vec3(${CONFIG.Canvas.lightLevels.bright.toFixed(3)}, ${CONFIG.Canvas.lightLevels.dim.toFixed(3)}, ${CONFIG.Canvas.lightLevels.dark.toFixed(3)});

                        vec3 colorVision(vec3 colorBackground, float darknessLevel, float vision) {
                            float luminosity = 0.5;
                            float darknessPenalty = darknessLevel * 0.25 * (1.0 - luminosity);
                            float luminosityPenalty = clamp(luminosity * 2.0, 0.0, 1.0);
                            float lightPenalty = (1.0 - darknessPenalty) * luminosityPenalty;
                            vec3 colorBright = max(vec3(pv_lightLevels.x * lightPenalty), colorBackground);
                            vec3 colorDim = mix(colorBackground, colorBright, pv_lightLevels.y);
                            return mix(mix(colorBackground, colorDim, vision * 2.0),
                                       mix(colorDim, colorBright, vision * 2.0 - 1.0),
                                       step(0.5, vision));
                        }

                        void main() {
                            float light = pv_lflc.b;

                            colorBackground = pv_cb = texture2D(pv_colorBackgroundSampler, vSamplerUvs).rgb;

                            if (!darkness) {
                                vec4 dsvb = texture2D(pv_sampler2, vSamplerUvs);

                                float luminosity = pv_luminosity;
                                float darknessLevel = dsvb.r;
                                float darknessPenalty = darknessLevel * 0.25 * (1.0 - luminosity);
                                float luminosityPenalty = clamp(luminosity * 2.0, 0.0, 1.0);
                                float lightPenalty = (1.0 - darknessPenalty) * luminosityPenalty;

                                colorBright = max(vec3(pv_lightLevels.x * lightPenalty), colorBackground);
                                colorDim = mix(colorBackground, colorBright, pv_lightLevels.y);

                                if (!pv_sight) {
                                    float vision = dsvb.b;
                                    float boost = dsvb.a;

                                    #ifdef PF2E_RULES_BASED_VISION
                                    vision = min(vision, clamp((darknessLevel - 0.25) / 0.5, 0.0, 1.0));
                                    boost = min(boost, clamp((darknessLevel - 0.25) / 0.5, 0.0, 1.0));
                                    #endif

                                    colorBackground = colorVision(pv_cb, darknessLevel, min(vision, mix(0.5, 1.0, boost)));
                                    colorBright = max(colorBright, colorBackground);
                                    colorDim = max(colorDim, colorBackground);

                                    vec3 a = vec3(0.0);
                                    vec3 b = vec3(0.0);

                                    if (boost < 1.0) {
                                        ratio = %ratio%;

                                        %wrapped%();

                                        a = finalColor;
                                    }

                                    if (boost > 0.0) {
                                        ratio = 1.0;

                                        %wrapped%();

                                        b = finalColor;
                                    }

                                    finalColor = mix(a, b, boost);

                                    if (gl_FragCoord.z < 1.0) {
                                        float t = smoothstep(0.0, 1.0, gl_FragCoord.z);

                                        finalColor = mix(mix(colorVision(pv_cb, darknessLevel, vision), pv_cb, clamp((light - t) / (1.0 - t), 0.0, 1.0)), finalColor, t);
                                    }
                                } else {
                                    ratio = %ratio%;

                                    %wrapped%();

                                    pv_alpha = min(pv_alpha, smoothstep(0.0, 1.0, gl_FragCoord.z));
                                    pv_alpha = min(pv_alpha, 1.0 - light);

                                    #ifdef PF2E_RULES_BASED_VISION
                                    pv_alpha = min(pv_alpha, clamp((darknessLevel - 0.25) / 0.5, 0.0, 1.0));
                                    #endif
                                }
                            } else {
                                ratio = %ratio%;
                                colorDim = %colorDim%;
                                colorBright = %colorBright%;

                                %wrapped%();

                                pv_alpha = min(pv_alpha, smoothstep(0.0, 1.0, gl_FragCoord.z));
                            }
                        }`
                    );
                }

                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(distance\(vUvs,\s*vec2\(0.5\)\))($|\W)/gm,
                    "$1/* $2 */ pv_distance(vUvs, vec2(0.5)) /* Patched by Perfect Vision */$3"
                );

                if (this === SwirlingRainbowColorationShader || this === RadialRainbowColorationShader || this === FairyLightColorationShader) {
                    this.fragmentShader = replace(this.fragmentShader,
                        /(^|\W)(length\(nuv\))($|\W)/gm,
                        "$1/* $2 */ pv_distance(nuv, vec2(0.0)) /* Patched by Perfect Vision */$3"
                    );
                }

                if (this === RoilingIlluminationShader) {
                    this.fragmentShader = replace(this.fragmentShader,
                        /(^|\W)(distance\(uv,\s*PIVOT\))($|\W)/gm,
                        "$1/* $2 */ pv_distance(uv, PIVOT) /* Patched by Perfect Vision */$3"
                    );
                }

                if (this === AdaptiveBackgroundShader) {
                    this.fragmentShader = replace(this.fragmentShader,
                        /(^|\W)(gl_FragColor\s*=[^}]+)($|\W)/gm,
                        `$1/* $2 */ pv_alpha *= baseColor.a * (1.0 - smoothstep(0.75, 1.0, dist * dist * dist)); /* Patched by Perfect Vision */$3`
                    );
                }

                this.fragmentShader = wrap(this.fragmentShader, ["vUvs", "vSamplerUvs"], `\
                    uniform ${PIXI.settings.PRECISION_VERTEX} vec4 viewportFrame;
                    uniform ${PIXI.settings.PRECISION_VERTEX} mat3 projectionMatrixInverse;
                    uniform ${PIXI.settings.PRECISION_VERTEX} mat3 translationMatrixInverse;

                    uniform sampler2D pv_sampler1;

                    void main() {
                        ${PIXI.settings.PRECISION_VERTEX} vec3 worldPosition = projectionMatrixInverse * vec3(((gl_FragCoord.xy - viewportFrame.xy) / viewportFrame.zw) * 2.0 - 1.0, 1.0);
                        ${PIXI.settings.PRECISION_VERTEX} vec2 localPosition = (translationMatrixInverse * worldPosition).xy - pv_origin;

                        vUvs = (localPosition / pv_radius + 1.0) / 2.0;
                        vSamplerUvs = worldPosition.xy / screenDimensions;

                        pv_dist = pv_distance(localPosition, vec2(0.0));
                        pv_lflc = texture2D(pv_sampler1, vSamplerUvs);
                        pv_alpha = ${type === AdaptiveIlluminationShader ? "1.0" : "smoothstep(0.0, 1.0, gl_FragCoord.z)"};

                        #ifdef PV_OCCLUSION_MASK
                        pv_alpha = min(pv_alpha, pv_occlusionMaskAlpha(worldPosition.xy));
                        #endif

                        pv_alpha = min(pv_alpha, min(pv_lflc.r, pv_lflc.g));

                        %wrapped%();

                        pv_fragColor = ${type === AdaptiveIlluminationShader ? "darkness ? vec4(mix(mix(pv_cb, vec3(1.0), 1.0 - pv_alpha), finalColor, pv_alpha), 1.0) : vec4(mix(pv_cb, finalColor, pv_alpha), 1.0)" : `vec4(finalColor, 1.0) * pv_alpha`};
                    }`
                );

                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(varying)($|\W)/gm,
                    "$1/* $2 */ in /* Patched by Perfect Vision */$3"
                );
                this.fragmentShader = replace(this.fragmentShader,
                    keywords300es,
                    "$1/* $2 */ pv_$2 /* Patched by Perfect Vision */$3"
                );
                this.fragmentShader = replace(this.fragmentShader,
                    /(^|\W)(texture2D)($|\W)/gm,
                    "$1/* $2 */ texture /* Patched by Perfect Vision */$3"
                );
                this.fragmentShader = `#version 300 es\n
                    /* Patched by Perfect Vision */
                    precision ${PIXI.settings.PRECISION_FRAGMENT} float;
                    uniform vec2 pv_origin;
                    uniform float pv_radius;
                    uniform float pv_smoothness;
                    layout(location = 0) out vec4 pv_fragColor;
                    vec4 pv_unused_vec4;
                    #define gl_FragColor pv_unused_vec4
                    vec4 pv_lflc;
                    float pv_dist;
                    float pv_alpha;
                    vec3 pv_cb;
                    vec3 finalColor;
                    vec4 baseColor;
                    #define PV_GRADUAL_SMOOTHNESS 0.2
                    %OCCLUSION_MASK%
                    ${OCCLUSION_MASK}
                    %LIGHT_MASK%
                    ${SHAPES_AND_DISTANCE}
                    %PF2E_RULES_BASED_VISION%
                    vec4 pv_unpremultiply(vec4 color) { return color.a > 0.0 ? vec4(color.rgb / color.a, color.a) : vec4(0.0); }
                    /* ------------------------- */\n\n\
                    ${this.fragmentShader}`;
            }

            this.fragmentShader = this.fragmentShader
                .replace(/%OCCLUSION_MASK%/gm, game.modules.get("levels")?.active ? "#define PV_OCCLUSION_MASK" : "")
                .replace(/%LIGHT_MASK%/gm, game.modules.get("lightmask")?.active ? "#define PV_LIGHT_MASK" : "")
                .replace(/%PF2E_RULES_BASED_VISION%/gm, game.system.id === "pf2e" && game.settings.get("pf2e", "automation.rulesBasedVision") ? "#define PF2E_RULES_BASED_VISION" : "");
        }
    }

    if (defaultUniforms) {
        defaultUniforms.fovTexture = defaultUniforms.fovTexture ?? PIXI.Texture.EMPTY;
    }

    const shader = create.call(this, defaultUniforms);

    shader.uniforms.pv_origin = [0, 0];
    shader.uniforms.pv_radius = 0;
    shader.uniforms.pv_smoothness = 0;
    shader.uniforms.pv_sampler1 = PIXI.Texture.EMPTY;
    shader.uniforms.pv_occlusionMaskSampler = PIXI.Texture.WHITE;
    shader.uniforms.pv_occlusionMaskFrame = new Float32Array(4);
    shader.uniforms.pv_shape = 0;
    shader.uniforms.pv_rotation = 0;

    if (shader instanceof AdaptiveIlluminationShader) {
        shader.uniforms.pv_sight = false;
        shader.uniforms.pv_luminosity = 0;
        shader.uniforms.pv_sampler2 = PIXI.Texture.EMPTY;
        shader.uniforms.pv_colorBackgroundSampler = PIXI.Texture.EMPTY;
    } else if (shader instanceof DelimiterShader) {
        shader.uniforms.pv_sight = false;
        shader.uniforms.pv_darknessSaturationBoost = PIXI.Texture.EMPTY;
    }

    return shader;
};
