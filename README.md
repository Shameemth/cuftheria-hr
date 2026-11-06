# Restaurant Control – setup guide

## 1. Run it
1. Install Node.js 18 or newer (nodejs.org).
2. Open a terminal in this folder and run:  `npm install`  then  `npm start`
3. Open http://localhost:3000
4. First start prints the administrator login (username `admin` + a random password). Log in and change it.
   To choose your own first password:  `ADMIN_PASSWORD=YourPass123 npm start`  (Windows: `set ADMIN_PASSWORD=YourPass123` first)

Upgrading from the earlier version? Copy your old `data` folder into this one – employees, branches and users are kept.

## 2. Who can do what
| Role | Can do |
|---|---|
| Administrator | Everything: employees, sales, expenses, reports, users, branches, settings |
| Branch manager | Enter daily sales and expenses for their own branch only (today + last 14 days), see their own branch report. Cannot see employees or salaries |
| Viewer | Read only: dashboard, employees, all reports, alerts |

Create users under **Users** (administrator only). For a manager, choose their branch.

## 3. Daily routine
- Each branch's sales (cash / card / delivery apps / other) go in **Daily sales**. The administrator can fill all 25 branches on one screen.
- Expenses go in **Expenses** by category. Staff salaries are NOT typed in: they are taken from each employee's monthly salary and pro-rated for the report period.
- **Reports**: pick Today / This week / This month / any dates, all branches or one. Download as Excel (CSV) or print / save as PDF.
- Weekly (Mon–Sun) and monthly reports are created automatically once each period ends, and are listed under Reports.

## 4. Downloads (Excel) whenever you need them
Every download opens directly in Excel (CSV format).
- **Reports → Download Excel:** sales, expenses, payroll and profit for any dates, all branches or one.
- **Reports → click a weekly or monthly report → Download this report:** the automatic reports.
- **Passport & visa → Download Excel:** every passport and visa that is expired or expiring within the number of days you choose (30, 60, 90, 180, 365 or any number).
- **Employees → Download list:** the full employee list with all details.
Passport and visa dates also show in red / amber in the app, and the Dashboard shows how many need attention.

## 5. Putting it online
- Needs a server or hosting that keeps Node.js running 24/7 (the automatic reports only run while it is on).
- Use HTTPS, then also set `COOKIE_SECURE=1` (and `TRUST_PROXY=1` if behind a proxy such as Nginx or a hosting platform).
- The `data` folder holds everything. **Back it up regularly** (copy the folder). On hosting, attach persistent storage to it.
- Other settings: `PORT=3000`, `APP_TIMEZONE=Asia/Dubai`, `DATA_DIR=/path/to/data`.

## 6. Install on phones (works like an app)
Once the app is online with HTTPS (section 5), every branch can install it on their phone. No Play Store or App Store needed.
- **Android (Chrome):** open the web address, log in, then tap the **Install app** button in the app (or the browser menu ⋮ → "Install app" / "Add to Home screen").
- **iPhone (Safari only):** open the web address, tap the **Share** button → **Add to Home Screen**.
- **Computer (Chrome / Edge):** click the install icon at the right of the address bar.
It then opens full-screen with its own icon. It still needs internet: all data is kept on the server, and nothing about employees, salaries or sales is stored on the phone.
Installing only works from an HTTPS address (a plain http:// address on the internet will not offer "Install").
