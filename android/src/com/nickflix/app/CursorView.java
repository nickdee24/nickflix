package com.nickflix.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/** The on-screen pointer steered by the TV remote. Draws only; never takes touches or focus. */
public class CursorView extends View {
    float x = -1, y = -1;
    private boolean pressed;
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint shadow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path arrow = new Path();
    private final float unit;

    public CursorView(Context c) {
        super(c);
        setFocusable(false);
        setClickable(false);
        unit = c.getResources().getDisplayMetrics().density;
        fill.setColor(0xFFDB202C); // NickFlix red
        fill.setStyle(Paint.Style.FILL);
        edge.setColor(0xFFFFFFFF);
        edge.setStyle(Paint.Style.STROKE);
        edge.setStrokeWidth(2.2f * unit);
        edge.setStrokeJoin(Paint.Join.ROUND);
        shadow.setColor(0x66000000);
        shadow.setStyle(Paint.Style.FILL);
        // A classic arrow, tip at (0,0)
        arrow.moveTo(0, 0);
        arrow.lineTo(0, 22);
        arrow.lineTo(6, 16.5f);
        arrow.lineTo(10.5f, 26);
        arrow.lineTo(14.5f, 24);
        arrow.lineTo(10, 15);
        arrow.lineTo(17.5f, 15);
        arrow.close();
    }

    void place(float nx, float ny) {
        x = nx;
        y = ny;
        invalidate();
    }

    @Override
    public void setPressed(boolean p) {
        pressed = p;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (x < 0) return;
        float s = unit * (pressed ? 1.0f : 1.2f);
        canvas.save();
        canvas.translate(x + 1.5f * unit, y + 2.5f * unit);
        canvas.scale(s, s);
        canvas.drawPath(arrow, shadow);
        canvas.restore();
        canvas.save();
        canvas.translate(x, y);
        canvas.scale(s, s);
        canvas.drawPath(arrow, fill);
        edge.setStrokeWidth(2.2f * unit / s);
        canvas.drawPath(arrow, edge);
        canvas.restore();
    }
}
