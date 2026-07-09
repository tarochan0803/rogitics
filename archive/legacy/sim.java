import javax.swing.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;

// メインクラス
public class TruckSim extends JFrame {

    public TruckSim() {
        initUI();
    }

    private void initUI() {
        add(new GamePanel());
        setTitle("Java Truck Simulator 2D");
        setSize(800, 600);
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setLocationRelativeTo(null);
        setResizable(false);
    }

    public static void main(String[] args) {
        EventQueue.invokeLater(() -> {
            TruckSim ex = new TruckSim();
            ex.setVisible(true);
        });
    }
}

// ゲーム画面の描画とループ管理
class GamePanel extends JPanel implements ActionListener {

    private Timer timer;
    private Truck truck;
    private final int DELAY = 16; // 約60FPS

    // キー入力状態
    private boolean upPressed = false;
    private boolean downPressed = false;
    private boolean leftPressed = false;
    private boolean rightPressed = false;

    public GamePanel() {
        initBoard();
    }

    private void initBoard() {
        setBackground(Color.DARK_GRAY);
        setFocusable(true);
        addKeyListener(new TAdapter());

        // トラックの初期位置 (x, y, 角度)
        truck = new Truck(100, 100, 0);

        timer = new Timer(DELAY, this);
        timer.start();
    }

    @Override
    public void paintComponent(Graphics g) {
        super.paintComponent(g);
        doDrawing(g);
    }

    private void doDrawing(Graphics g) {
        Graphics2D g2d = (Graphics2D) g;
        
        // アンチエイリアス（滑らかに描画）
        g2d.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        truck.draw(g2d);
        
        // 情報表示
        g2d.setColor(Color.WHITE);
        g2d.drawString("Speed: " + String.format("%.2f", truck.getSpeed()), 10, 20);
        g2d.drawString("Angle: " + (int)Math.toDegrees(truck.getAngle()), 10, 40);
    }

    // ゲームループ（定期的に呼ばれる）
    @Override
    public void actionPerformed(ActionEvent e) {
        updateTruck();
        repaint();
    }

    private void updateTruck() {
        if (upPressed) truck.accelerate();
        if (downPressed) truck.brake();
        if (leftPressed) truck.turnLeft();
        if (rightPressed) truck.turnRight();
        
        if (!upPressed && !downPressed) truck.friction(); // アクセル離したら減速

        truck.move();
    }

    // キー入力のリスナー
    private class TAdapter extends KeyAdapter {
        @Override
        public void keyPressed(KeyEvent e) {
            int key = e.getKeyCode();
            if (key == KeyEvent.VK_UP) upPressed = true;
            if (key == KeyEvent.VK_DOWN) downPressed = true;
            if (key == KeyEvent.VK_LEFT) leftPressed = true;
            if (key == KeyEvent.VK_RIGHT) rightPressed = true;
        }

        @Override
        public void keyReleased(KeyEvent e) {
            int key = e.getKeyCode();
            if (key == KeyEvent.VK_UP) upPressed = false;
            if (key == KeyEvent.VK_DOWN) downPressed = false;
            if (key == KeyEvent.VK_LEFT) leftPressed = false;
            if (key == KeyEvent.VK_RIGHT) rightPressed = false;
        }
    }
}

// トラッククラス（物理計算と描画）
class Truck {
    private double x, y;
    private double angle; // ラジアン
    private double speed;
    
    // 定数（調整パラメータ）
    private final double MAX_SPEED = 5.0;
    private final double ACCELERATION = 0.1;
    private final double TURN_SPEED = 0.05;
    private final double FRICTION = 0.05;

    public Truck(double x, double y, double angle) {
        this.x = x;
        this.y = y;
        this.angle = angle;
        this.speed = 0;
    }

    public void accelerate() {
        if (speed < MAX_SPEED) speed += ACCELERATION;
    }

    public void brake() {
        if (speed > -MAX_SPEED/2) speed -= ACCELERATION;
    }

    public void friction() {
        if (speed > 0) {
            speed -= FRICTION;
            if (speed < 0) speed = 0;
        } else if (speed < 0) {
            speed += FRICTION;
            if (speed > 0) speed = 0;
        }
    }

    public void turnLeft() {
        if (Math.abs(speed) > 0.1) // 止まっているときは旋回できない
            angle -= TURN_SPEED;
    }

    public void turnRight() {
        if (Math.abs(speed) > 0.1)
            angle += TURN_SPEED;
    }

    public void move() {
        // 三角関数を使って進行方向へ移動
        x += Math.cos(angle) * speed;
        y += Math.sin(angle) * speed;
    }

    public void draw(Graphics2D g2d) {
        // 現在の座標系を保存
        var oldTransform = g2d.getTransform();

        // トラックの位置へ移動し、回転させる
        g2d.translate(x, y);
        g2d.rotate(angle);

        // トラックの本体（キャビン）
        g2d.setColor(Color.RED);
        g2d.fillRect(-20, -10, 40, 20); // 中心を基準に描画
        
        // ヘッドライト（黄色）
        g2d.setColor(Color.YELLOW);
        g2d.fillRect(15, -8, 5, 5);
        g2d.fillRect(15, 3, 5, 5);

        // 座標系を元に戻す
        g2d.setTransform(oldTransform);
    }
    
    public double getSpeed() { return speed; }
    public double getAngle() { return angle; }
}