require("dotenv").config();
const axios = require("axios");
const cheerio = require("cheerio");
const { MongoClient } = require("mongodb");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

// ================== الإعدادات الرئيسية (عدّل هذه القيم) ==================

// !! هام: استبدل هذه القيمة بالكوكي الحقيقية والحديثة الخاصة بك
const SESSION_COOKIE = process.env.SESSION_COOKIE;

const USER_AGENT = process.env.USER_AGENT;

// إعدادات قاعدة البيانات
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "khamsat_requests";
const COLLECTION_NAME = "projects_full";

// إعدادات تيليجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// إعدادات السكربت
const BASE_URL = "https://khamsat.com";
const MAIN_PAGE_URL = `${BASE_URL}/community/requests`;
const DELAY_BETWEEN_DETAILS_REQUESTS = 20000; // 20 ثانية
const CRON_SCHEDULE = "*/5 * * * *"; // كل 5 دقيقة

// ================== تهيئة بوت التيليجرام و Axios ==================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// إضافة headers كاملة لجعله يحاكي المتصفح الحقيقي بشكل أفضل
const apiClient = axios.create({
  headers: {
    Cookie: SESSION_COOKIE,
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    Referer: "https://khamsat.com/community",
    "Sec-Ch-Ua":
      '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  },
});

// ================== الوظائف المساعدة (Helper Functions) ==================

const getDescriptionPage = async (page) => {
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);
  const cheerio = require("cheerio");

  try {
    const { stdout, stderr } = await execPromise(
      `curl "${page}" -X GET -H "User-Agent: ${USER_AGENT}" -H "Cookie: rack.session=${SESSION_COOKIE}"`
    );

    if (stderr) {
      console.warn("⚠ تحذير:", stderr);
    }

    const $ = cheerio.load(stdout);
    const description = $("article.replace_urls").first().text().trim();
    return description;
  } catch (error) {
    console.error(`❌ فشل جلب الوصف من ${page}:`, error.message);
    return "";
  }
};

/**
 * دالة مساعدة لتحليل HTML وإرجاع مصفوفة من بيانات المشاريع الأولية
 */
function parseProjectsFromHTML(html) {
  const projects = [];
  if (typeof html !== "string") {
    return projects;
  }
  const $ = cheerio.load(html);
  // المحدد الصحيح لصف المشاريع هو tr.forum_post
  const projectRows = $("tr.forum_post");

  projectRows.each((index, row) => {
    const projectElement = $(row);
    const idString = projectElement.attr("id");
    if (!idString) return;

    const projectId = parseInt(idString.replace("forum_post-", ""));
    if (!projectId) return;

    const titleElement = projectElement.find("td.details-td h3.details-head a");
    const userElement = projectElement.find("ul.details-list li a.user");
    const dateElement = projectElement.find("li.d-lg-inline-block.d-none span");

    projects.push({
      _id: projectId,
      title: titleElement.text().trim(),
      link: `${BASE_URL}${titleElement.attr("href")}`,
      author: userElement.text().trim(),
      date: new Date(dateElement.attr("title")),
      dateString: dateElement.attr("title"),
    });
  });
  return projects;
}

/**
 * دالة لجلب الوصف التفصيلي لمشروع واحد
 */
async function scrapeProjectDescription(projectUrl) {
  try {
    const description = await getDescriptionPage(projectUrl);
    return description || "";
  } catch (error) {
    console.error(`    - ❌ فشل جلب الوصف من ${projectUrl}:`, error.message);
    return "";
  }
}

/**
 * دالة لإرسال إشعار تيليجرام
 */
async function sendTelegramNotification(project) {
  const shortDescription = project.description.substring(0, 500).trim();

  const message = `
📢 <b>طلب جديد على خمسات!</b>

<b>📌 العنوان:</b> ${project.title}
<b>👤 صاحب الطلب:</b> ${project.author}
<b>📝 الوصف (أول 500 حرف):</b>
${shortDescription}...
  `;

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔗 عرض الطلب",
              url: project.link,
            },
          ],
        ],
      },
    });
    console.log(`- 💬 تم إرسال إشعار تيليجرام للمشروع: "${project.title}"`);
  } catch (error) {
    console.error("❌ فشل إرسال إشعار تيليجرام:", error.message);
  }
}

// ================== وظيفة الـ Scraper الرئيسية (المنطق المبسط والآمن) ==================

async function scraperCycle() {
  console.log(
    `\n============== [${new Date().toLocaleString("ar-EG")}] ==============`
  );
  console.log("🚀 بدء دورة جلب جديدة (GET فقط)...");

  let dbClient;
  try {
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    const projectsCollection = dbClient.db(DB_NAME).collection(COLLECTION_NAME);
    console.log("✅ تم الاتصال بقاعدة البيانات.");

    const mainPageResponse = await apiClient.get(MAIN_PAGE_URL);
    const allUniqueProjects = parseProjectsFromHTML(mainPageResponse.data);
    console.log(
      `🔍 تم تحليل ${allUniqueProjects.length} مشروع من الصفحة الرئيسية.`
    );

    // نعكس ترتيب المشاريع لنبدأ بالأقدم فالأحدث، لضمان أننا ننتظر بعد كل طلب جديد
    for (const project of allUniqueProjects.reverse()) {
      const existingProject = await projectsCollection.findOne({
        _id: project._id,
      });
      if (!existingProject) {
        console.log(`- 🟢 مشروع جديد تم العثور عليه: "${project.title}"`);

        const description = await scrapeProjectDescription(project.link);
        // نتأكد أن الوصف لم يرجع فارغاً بسبب الحظر
        if (description && description !== "لم يتمكن من جلب الوصف.") {
          project.description = description;
          await projectsCollection.insertOne(project);
          console.log(`- 💾 تم حفظ المشروع الكامل في قاعدة البيانات.`);
          await sendTelegramNotification(project);
        } else {
          console.log(
            `- ⚠️ تم تخطي المشروع "${project.title}" بسبب فشل جلب الوصف.`
          );
        }

        console.log(
          `- ⏳ انتظار ${DELAY_BETWEEN_DETAILS_REQUESTS / 1000} ثانية...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_BETWEEN_DETAILS_REQUESTS)
        );
      }
    }
    console.log("✨ انتهت دورة الجلب بنجاح.");
  } catch (error) {
    console.error(
      "❌ حدث خطأ فادح في الدورة الرئيسية:",
      error.response
        ? `${error.response.status}: ${error.response.statusText}`
        : error.message
    );
  } finally {
    if (dbClient) {
      await dbClient.close();
      console.log("🔌 تم إغلاق الاتصال بقاعدة البيانات.");
    }
  }
}

// ================== الجدولة الزمنية ==================

console.log("🕒 السكريبت الشامل جاهز وسيعمل حسب الجدول الزمني.");
console.log(`⏰ سيتم تنفيذ المهمة كل 5 دقائق.`);

cron.schedule(CRON_SCHEDULE, scraperCycle);

// للاختبار الفوري عند تشغيل السكريبت لأول مرة
scraperCycle();

// curl "https://khamsat.com/community/requests/763480-%D8%AA%D8%B9%D8%AF%D9%8A%D9%84-%D8%A3%D8%BA%D9%84%D9%81%D8%A9-%D8%A3%D9%84%D8%B9%D8%A7%D8%A8-ps4-%D9%84%D8%A5%D8%AE%D9%81%D8%A7%D8%A1-%D8%B5%D9%88%D8%B1-%D8%A7%D9%84%D8%A3%D8%B1%D9%88%D8%A7%D8%AD" -X GET -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36" -H "Cookie: rack.session=xWtalEMiF6DImbKp8xF2ZbywwQTkV3QrDk0FKd6hgDVApVORq2458JL2NNHXolyPsX7SkRBqIRpRy8dy654OpzlMj1qW1cQSq5J7zcyEu63zyrk36CvPH4I%2B%2FKlUguU95UhPjCx772OATu7STJcL4PaCUwMGsJoQI1oYzl0J3P4z1k5miICYyoXzJR681ZK9cRKHuIqVeLkN1Zavq4yDdXc6pQCU8yIa8FrfN86LvNTVjo3ePrvmZzDQj1%2FwIw7esZD7%2F7NilLeDGgLUPUvI4DrAeerVqL5bBvUyLFkUi0xE0lDpXxofJGUWXC04C40FRXkbuBCXfIvZYyFKkV98qQHzhn73GsW5U0ObTjm%2BBybj5n6QzhcmiYgwtvwqoCVayaVL0QBcBYquC38BSbhj6a951N6IxGFp7160TvUDWc93t%2BUlfEeMu5f58ybl47z8VuWQ%2FrsS77bx3FMxg5isiS13n5wTwl%2FtGFyboViuNWWLjaB0gfttlTxFaKKdjhTYpqYGKWLBvjwXzCdGLA5OK6oHGOifha2Sd%2BkWeGYx%2FkkI2oOHhqUGtADIZqqQsI87VO7t%2F5uK%2FDIvV7%2FF%2BzkIYoJ2XCy9wR91LPmD%2FfTJQpU%3D"
// (async () => {
//   const { exec } = require("child_process");
//   const fs = require("fs");

//   // هنا الأمر الحقيقي اللي بيشتغل عندك في الطرفية
//   const curlScript = `
// curl "https://khamsat.com/community/requests/763480-%D8%AA%D8%B9%D8%AF%D9%8A%D9%84-%D8%A3%D8%BA%D9%84%D9%81%D8%A9-%D8%A3%D9%84%D8%B9%D8%A7%D8%A8-ps4-%D9%84%D8%A5%D8%AE%D9%81%D8%A7%D8%A1-%D8%B5%D9%88%D8%B1-%D8%A7%D9%84%D8%A3%D8%B1%D9%88%D8%A7%D8%AD" \\
//  -X GET \\
//  -H "User-Agent: ${USER_AGENT}" \\
//  -H "Cookie: rack.session=${SESSION_COOKIE}" > output.html
// `;

//   fs.writeFileSync("run.sh", curlScript, { encoding: "utf-8" });

//   exec("bash run.sh", (error, stdout, stderr) => {
//     if (error) {
//       console.error(`❌ خطأ: ${error.message}`);
//       return;
//     }
//     if (stderr) {
//       console.error(`⚠ تحذير: ${stderr}`);
//     }

//     console.log("✔ تم تنفيذ السكربت، شوف output.html");
//   });
// })();
