import { patch } from "../utils/patch.js";

Hooks.once("init", () => {
    patch("Token.prototype.refresh", "WRAPPER", function (wrapped, ...args) {
        wrapped(...args);

        if (!this._pv_border) {
            this._pv_border = new ObjectHUD(this);
        } else {
            this._pv_border.removeChildren();
        }

        this._pv_border.addChild(this.border);

        if (this._hover) {
            canvas._pv_highlights_overhead.borders.addChild(this._pv_border);
        } else {
            canvas._pv_highlights_underfoot.borders.addChild(this._pv_border);
        }
    });

    patch("Token.prototype.destroy", "WRAPPER", function (wrapped, options) {
        this._pv_border?.destroy(options);
        this._pv_border = null;

        wrapped(options);
    });

    patch("Token.prototype._drawHUD", "WRAPPER", function (wrapped, ...args) {
        const hud = wrapped(...args);

        hud.removeChild(this.hud.nameplate);
        hud.addChild(this.hud.nameplate);

        return hud;
    });
});
